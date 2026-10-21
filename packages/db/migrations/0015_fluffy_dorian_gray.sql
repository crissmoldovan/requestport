ALTER TABLE "agent_oauth_grants" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD COLUMN "issued_by_grant_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_issued_by_grant_id_agent_oauth_grants_id_fk" FOREIGN KEY ("issued_by_grant_id") REFERENCES "public"."agent_oauth_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_oauth_grants" ADD CONSTRAINT "agent_oauth_grants_provisioning_check" CHECK (("agent_oauth_grants"."project_id" is not null and not ("agent_oauth_grants"."scopes" ? 'project:provision'))
          or ("agent_oauth_grants"."project_id" is null and "agent_oauth_grants"."scopes" = '["project:provision"]'::jsonb));