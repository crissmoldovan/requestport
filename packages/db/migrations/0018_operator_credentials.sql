-- Bound every lock this migration waits for, and bound it first, as 0014 and
-- 0017 do. Replacing the audit CHECK below takes ACCESS EXCLUSIVE on
-- `security_audit_records`, which many write paths append to, and the
-- foreign keys take SHARE ROW EXCLUSIVE on `organizations`, `user`, `apikey`
-- and `projects`. With lock_timeout at the server default of 0 (wait forever),
-- one long transaction on any of them would queue this migration, and every
-- writer behind it, until that transaction ended. Drizzle applies the pending
-- migrations in one transaction, so a timeout rolls the apply back whole and it
-- can simply be run again.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "operator_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"member_user_id" text NOT NULL,
	"project_id" uuid,
	"better_auth_api_key_id" text,
	"lineage_id" uuid NOT NULL,
	"rotated_from_id" uuid,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"fingerprint" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"overlap_expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_credentials_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "operator_credentials_version_check" CHECK ("operator_credentials"."version" > 0),
	CONSTRAINT "operator_credentials_scopes_check" CHECK (jsonb_typeof("operator_credentials"."scopes") = 'array' and not ("operator_credentials"."scopes" ?| array['project:provision', 'agent:manage', 'operator:manage', 'work:claim', 'work:update', 'work:sweep', 'agent:register', 'workspace:telemetry:reveal'])),
	CONSTRAINT "operator_credentials_expiry_check" CHECK ("operator_credentials"."expires_at" > "operator_credentials"."created_at" and "operator_credentials"."expires_at" <= "operator_credentials"."created_at" + interval '90 days')
);
--> statement-breakpoint
ALTER TABLE "operator_credentials" ADD CONSTRAINT "operator_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_credentials" ADD CONSTRAINT "operator_credentials_member_user_id_user_id_fk" FOREIGN KEY ("member_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_credentials" ADD CONSTRAINT "operator_credentials_better_auth_api_key_id_apikey_id_fk" FOREIGN KEY ("better_auth_api_key_id") REFERENCES "public"."apikey"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_credentials" ADD CONSTRAINT "operator_credentials_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_credentials_better_auth_key_unique" ON "operator_credentials" USING btree ("better_auth_api_key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_credentials_fingerprint_unique" ON "operator_credentials" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "operator_credentials_member_idx" ON "operator_credentials" USING btree ("member_user_id");--> statement-breakpoint
CREATE INDEX "operator_credentials_lineage_idx" ON "operator_credentials" USING btree ("organization_id","lineage_id");--> statement-breakpoint
-- Plan 13, F.3 (F3-2, ruling 10): the audit actor CHECK also admits
-- 'service', so a revocation by an operator credential is recorded as the
-- service actor it is. It admits a superset of what it admitted, and the code
-- before this release neither writes nor reads 'service' there. The old
-- constraint is dropped only to be re-added, wider, under the same name: added
-- NOT VALID, then validated as its own statement. The validation still scans
-- every existing row, and because the pending migrations run in one
-- transaction it does so while the ACCESS EXCLUSIVE lock the DROP took is
-- still held.
ALTER TABLE "security_audit_records" DROP CONSTRAINT "security_audit_records_actor_type_check";--> statement-breakpoint
ALTER TABLE "security_audit_records" ADD CONSTRAINT "security_audit_records_actor_type_check" CHECK ("security_audit_records"."actor_type" in ('user', 'agent', 'service', 'system')) NOT VALID;--> statement-breakpoint
ALTER TABLE "security_audit_records" VALIDATE CONSTRAINT "security_audit_records_actor_type_check";