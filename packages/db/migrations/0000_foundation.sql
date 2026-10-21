CREATE TABLE "security_audit_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"reason" text NOT NULL,
	"field_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"correlation_id" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_audit_records_actor_type_check" CHECK ("security_audit_records"."actor_type" in ('user', 'agent', 'system'))
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"normalized_email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_role_check" CHECK ("invitations"."role" in ('owner', 'admin', 'member'))
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_members_role_check" CHECK ("organization_members"."role" in ('owner', 'admin', 'member')),
	CONSTRAINT "organization_members_status_check" CHECK ("organization_members"."status" in ('active', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_status_check" CHECK ("organizations"."status" in ('active', 'suspended', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "signup_allowlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"normalized_email" text NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signup_allowlist_status_check" CHECK ("signup_allowlist"."status" in ('active', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "project_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_aliases_source_check" CHECK ("project_aliases"."source" in ('manual', 'rename', 'import'))
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_members_role_check" CHECK ("project_members"."role" in ('maintainer', 'contributor', 'viewer')),
	CONSTRAINT "project_members_status_check" CHECK ("project_members"."status" in ('active', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "project_repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"browse_url" text NOT NULL,
	"clone_url" text NOT NULL,
	"repository_slug" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_repositories_provider_check" CHECK ("project_repositories"."provider" in ('github')),
	CONSTRAINT "project_repositories_status_check" CHECK ("project_repositories"."status" in ('active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"key_prefix" text NOT NULL,
	"description" text,
	"status" text NOT NULL,
	"default_lane_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "projects_status_check" CHECK ("projects"."status" in ('active', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "security_audit_records" ADD CONSTRAINT "security_audit_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_aliases" ADD CONSTRAINT "project_aliases_organization_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_organization_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_organization_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "security_audit_records_organization_id_idx" ON "security_audit_records" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "security_audit_records_actor_idx" ON "security_audit_records" USING btree ("actor_type","actor_id");--> statement-breakpoint
CREATE INDEX "security_audit_records_target_idx" ON "security_audit_records" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "security_audit_records_correlation_id_idx" ON "security_audit_records" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "security_audit_records_occurred_at_idx" ON "security_audit_records" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "invitations_organization_id_idx" ON "invitations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitations_created_by_user_id_idx" ON "invitations" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_organization_email_ci_unique" ON "invitations" USING btree ("organization_id",lower("normalized_email"));--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_hash_unique" ON "invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "organization_members_organization_id_idx" ON "organization_members" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "organization_members_user_id_idx" ON "organization_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_members_organization_user_unique" ON "organization_members" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_ci_unique" ON "organizations" USING btree (lower("slug"));--> statement-breakpoint
CREATE UNIQUE INDEX "signup_allowlist_normalized_email_ci_unique" ON "signup_allowlist" USING btree (lower("normalized_email"));--> statement-breakpoint
CREATE INDEX "signup_allowlist_created_by_user_id_idx" ON "signup_allowlist" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "project_aliases_organization_id_idx" ON "project_aliases" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "project_aliases_project_id_idx" ON "project_aliases" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_aliases_organization_alias_ci_unique" ON "project_aliases" USING btree ("organization_id",lower("alias"));--> statement-breakpoint
CREATE INDEX "project_members_organization_id_idx" ON "project_members" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "project_members_project_id_idx" ON "project_members" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_members_user_id_idx" ON "project_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_members_project_user_unique" ON "project_members" USING btree ("organization_id","project_id","user_id");--> statement-breakpoint
CREATE INDEX "project_repositories_organization_id_idx" ON "project_repositories" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "project_repositories_project_id_idx" ON "project_repositories" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_repositories_project_default_unique" ON "project_repositories" USING btree ("organization_id","project_id") WHERE "project_repositories"."is_default" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "project_repositories_provider_slug_ci_unique" ON "project_repositories" USING btree ("organization_id","provider",lower("repository_slug"));--> statement-breakpoint
CREATE INDEX "projects_organization_id_idx" ON "projects" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "projects_default_lane_id_idx" ON "projects" USING btree ("default_lane_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_organization_slug_ci_unique" ON "projects" USING btree ("organization_id",lower("slug"));--> statement-breakpoint
CREATE UNIQUE INDEX "projects_organization_key_prefix_ci_unique" ON "projects" USING btree ("organization_id",lower("key_prefix"));--> statement-breakpoint
CREATE FUNCTION "reject_security_audit_records_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'security_audit_records is append-only' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "security_audit_records_append_only"
BEFORE UPDATE OR DELETE ON "security_audit_records"
FOR EACH ROW
EXECUTE FUNCTION "reject_security_audit_records_mutation"();
