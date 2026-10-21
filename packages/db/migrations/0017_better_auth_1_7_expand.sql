-- Bound every lock this migration waits for, and bound it first. Each
-- `ALTER TABLE` below takes ACCESS EXCLUSIVE on `jwks` or one of the four
-- `oauth_*` tables Better Auth's OAuth flows read and write, and the foreign
-- keys take SHARE ROW EXCLUSIVE on `oauth_client`. With lock_timeout at the
-- server default of 0 (wait forever), one long transaction on any of them
-- would queue this migration, and every OAuth request behind it, until that
-- transaction ended. Every column added here is metadata only, so a granted
-- lock is held for milliseconds; 5s lets short transactions drain and costs a
-- queued request seconds at most. Drizzle applies the pending migrations in
-- one transaction, so a timeout rolls the apply back whole and it can simply
-- be run again. `0014` bounds its locks the same way, at 30s.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "oauth_client_assertion" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_client_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"access_token_ttl" integer,
	"refresh_token_ttl" integer,
	"signing_algorithm" text,
	"signing_key_id" text,
	"allowed_scopes" text[],
	"custom_claims" jsonb,
	"dpop_bound_access_tokens_required" boolean DEFAULT false,
	"disabled" boolean DEFAULT false,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"policy_version" integer DEFAULT 1,
	"metadata" jsonb,
	CONSTRAINT "oauth_resource_identifier_unique" UNIQUE("identifier")
);
--> statement-breakpoint
ALTER TABLE "jwks" ADD COLUMN "alg" text;--> statement-breakpoint
ALTER TABLE "jwks" ADD COLUMN "crv" text;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD COLUMN "authorization_code_id" text;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD COLUMN "resources" text[];--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD COLUMN "requested_user_info_claims" text[];--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD COLUMN "revoked" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD COLUMN "confirmation" jsonb;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "client_discovery_id" text;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "client_credentials_scopes" text[] DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "backchannel_logout_uri" text;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "backchannel_logout_session_required" boolean;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "application_type" text;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "jwks" text;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "jwks_uri" text;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "dpop_bound_access_tokens" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD COLUMN "resources" text[];--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD COLUMN "requested_user_info_claims" text[];--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "authorization_code_id" text;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "resources" text[];--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "requested_user_info_claims" text[];--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "rotated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "rotation_replay_response" text;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "rotation_replay_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "confirmation" jsonb;--> statement-breakpoint
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_resource_id_oauth_resource_identifier_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."oauth_resource"("identifier") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_client_resource_client_id_resource_id_unique" ON "oauth_client_resource" USING btree ("client_id","resource_id");--> statement-breakpoint
CREATE INDEX "oauth_client_resource_client_id_idx" ON "oauth_client_resource" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_client_resource_resource_id_idx" ON "oauth_client_resource" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "oauth_access_token_authorization_code_id_idx" ON "oauth_access_token" USING btree ("authorization_code_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_token_authorization_code_id_idx" ON "oauth_refresh_token" USING btree ("authorization_code_id");--> statement-breakpoint
-- The backfill Better Auth's 1.7 upgrade guide asks for, written against the
-- read-only production read of 2026-09-28: two clients, both `type` NULL, so
-- the first statement updates no production row. It is still written for any
-- `type`, because a client may be registered between that read and the apply.
-- Neither statement touches a row it has already set, so running it again —
-- for a client registered between this apply and the 1.7 upgrade — is safe.
-- `user-agent-based` has no branch: the read found none, and the applier's
-- pre-apply check stops the apply if one has appeared.
-- The second statement is a guard, not the work: `client_credentials_scopes`
-- is added above with DEFAULT '{}', which fills every existing row as it is
-- added, and every client Better Auth 1.6.29 registers afterwards takes the
-- same default because its projection never names the column. So it updates
-- no row here, nor when re-run before the 1.7 upgrade. It stays because the
-- upgrade guide names it; no test can see it act.
UPDATE "oauth_client" SET "application_type" = "type"
WHERE "application_type" IS NULL AND "type" IN ('web', 'native');--> statement-breakpoint
UPDATE "oauth_client" SET "client_credentials_scopes" = '{}'
WHERE "client_credentials_scopes" IS NULL;
