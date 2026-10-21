-- The membership cutover guard must be the first thing this migration does.
-- Every later `ALTER TABLE ... ADD CONSTRAINT` and `CREATE TRIGGER` that names
-- a tenant table acquires SHARE ROW EXCLUSIVE on it by itself, so a bound set
-- afterwards would arrive too late: the first acquisition would already have
-- queued behind a long-running writer with lock_timeout still at the server
-- default of 0 (wait forever), blocking every membership write behind it.
SET LOCAL lock_timeout = '30s';--> statement-breakpoint
LOCK TABLE "public"."organization_members" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
CREATE TABLE "organization_appearance_defaults" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"aggregate_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"theme" text NOT NULL,
	"density" text NOT NULL,
	"mode" text NOT NULL,
	"last_updated_by_user_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_appearance_defaults_theme_check" CHECK ("organization_appearance_defaults"."theme" in ('requestport', 'cue', 'terminal', 'signal', 'venu', 'hivehub', 'dusk', 'luma', 'snuffle')),
	CONSTRAINT "organization_appearance_defaults_density_check" CHECK ("organization_appearance_defaults"."density" in ('ultra-compact', 'normal', 'large')),
	CONSTRAINT "organization_appearance_defaults_mode_check" CHECK ("organization_appearance_defaults"."mode" in ('system', 'dark', 'light')),
	CONSTRAINT "organization_appearance_defaults_version_check" CHECK ("organization_appearance_defaults"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "user_appearance_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"aggregate_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"theme" text,
	"density" text,
	"mode" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_appearance_preferences_theme_check" CHECK ("user_appearance_preferences"."theme" is null or "user_appearance_preferences"."theme" in ('requestport', 'cue', 'terminal', 'signal', 'venu', 'hivehub', 'dusk', 'luma', 'snuffle')),
	CONSTRAINT "user_appearance_preferences_density_check" CHECK ("user_appearance_preferences"."density" is null or "user_appearance_preferences"."density" in ('ultra-compact', 'normal', 'large')),
	CONSTRAINT "user_appearance_preferences_mode_check" CHECK ("user_appearance_preferences"."mode" is null or "user_appearance_preferences"."mode" in ('system', 'dark', 'light')),
	CONSTRAINT "user_appearance_preferences_version_check" CHECK ("user_appearance_preferences"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "organization_appearance_defaults" ADD CONSTRAINT "organization_appearance_defaults_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Migration-owned, not Drizzle-generated: the last updater must be a membership
-- of this very tenant, and deleting that membership must null the reference
-- rather than block the delete. `ON DELETE SET NULL` needs the explicit column
-- list — without it PostgreSQL would also null "organization_id", which is this
-- table's NOT NULL primary key. Drizzle cannot express a per-column SET NULL,
-- so `packages/db/src/schema/appearance.ts` deliberately omits this constraint
-- and says why.
ALTER TABLE "organization_appearance_defaults" ADD CONSTRAINT "organization_appearance_defaults_updater_fk" FOREIGN KEY ("organization_id","last_updated_by_user_id") REFERENCES "public"."organization_members"("organization_id","user_id") ON DELETE SET NULL ("last_updated_by_user_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_appearance_preferences" ADD CONSTRAINT "user_appearance_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_appearance_defaults_aggregate_id_unique" ON "organization_appearance_defaults" USING btree ("aggregate_id");--> statement-breakpoint
CREATE INDEX "organization_appearance_defaults_updater_idx" ON "organization_appearance_defaults" USING btree ("last_updated_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_appearance_preferences_aggregate_id_unique" ON "user_appearance_preferences" USING btree ("aggregate_id");--> statement-breakpoint
CREATE FUNCTION "public"."requestport_initialize_organization_appearance"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	seeded_aggregate_id uuid;
	seeded_event_id uuid;
BEGIN
	-- Only a transition *into* active ownership seeds a default. An update that
	-- leaves an already-active owner active (a role touch, a joined_at refresh)
	-- must not re-enter this path.
	IF TG_OP = 'UPDATE' AND OLD."role" = 'owner' AND OLD."status" = 'active' THEN
		RETURN NULL;
	END IF;

	-- Two owners activated concurrently both reach here. The primary-key
	-- conflict serializes them and only the winner receives an aggregate id,
	-- so the event and the outbox row are written exactly once.
	INSERT INTO "public"."organization_appearance_defaults"
		("organization_id", "theme", "density", "mode",
		 "last_updated_by_user_id", "version")
	VALUES
		(NEW."organization_id", 'requestport', 'ultra-compact', 'system',
		 NEW."user_id", 1)
	ON CONFLICT ("organization_id") DO NOTHING
	RETURNING "aggregate_id" INTO seeded_aggregate_id;

	IF seeded_aggregate_id IS NULL THEN
		RETURN NULL;
	END IF;

	seeded_event_id := gen_random_uuid();

	-- The trigger cannot know which human caused this membership write without
	-- reading untrusted transaction-local state, so the envelope carries one
	-- fixed service actor and correlation/causation derived only from the
	-- tenant UUID. Initiating-user attribution stays in
	-- "last_updated_by_user_id" and in the existing organization audit trail.
	INSERT INTO "public"."domain_events"
		("id", "organization_id", "aggregate_type", "aggregate_id",
		 "aggregate_version", "type", "schema_version", "actor",
		 "correlation_id", "causation_id", "data", "links")
	VALUES
		(seeded_event_id, NEW."organization_id", 'organization_appearance',
		 seeded_aggregate_id, 1,
		 'appearance.organization_defaults_initialized.v1', 1,
		 '{"type": "service", "id": "requestport-appearance-default-initializer"}'::jsonb,
		 'appearance-default-init:' || NEW."organization_id"::text,
		 'appearance-default-init:' || NEW."organization_id"::text,
		 jsonb_build_object(
			'organizationId', NEW."organization_id"::text,
			'theme', 'requestport',
			'density', 'ultra-compact',
			'mode', 'system'),
		 '{}'::jsonb);

	INSERT INTO "public"."outbox" ("event_id") VALUES (seeded_event_id);

	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "requestport_initialize_organization_appearance"
AFTER INSERT OR UPDATE ON "public"."organization_members"
FOR EACH ROW
WHEN (NEW."role" = 'owner' AND NEW."status" = 'active')
EXECUTE FUNCTION "public"."requestport_initialize_organization_appearance"();--> statement-breakpoint
WITH "backfilled" AS (
	INSERT INTO "public"."organization_appearance_defaults"
		("organization_id", "theme", "density", "mode",
		 "last_updated_by_user_id", "version")
	SELECT "o"."id", 'requestport', 'ultra-compact', 'system',
		"first_owner"."user_id", 1
	FROM "public"."organizations" "o"
	JOIN LATERAL (
		SELECT "m"."user_id"
		FROM "public"."organization_members" "m"
		WHERE "m"."organization_id" = "o"."id"
			AND "m"."role" = 'owner'
			AND "m"."status" = 'active'
		ORDER BY "m"."joined_at", "m"."id"
		LIMIT 1
	) "first_owner" ON true
	ON CONFLICT ("organization_id") DO NOTHING
	RETURNING "organization_id", "aggregate_id"
), "seeded" AS (
	INSERT INTO "public"."domain_events"
		("id", "organization_id", "aggregate_type", "aggregate_id",
		 "aggregate_version", "type", "schema_version", "actor",
		 "correlation_id", "causation_id", "data", "links")
	SELECT gen_random_uuid(), "backfilled"."organization_id",
		'organization_appearance', "backfilled"."aggregate_id", 1,
		'appearance.organization_defaults_initialized.v1', 1,
		'{"type": "service", "id": "requestport-appearance-default-initializer"}'::jsonb,
		'appearance-default-init:' || "backfilled"."organization_id"::text,
		'appearance-default-init:' || "backfilled"."organization_id"::text,
		jsonb_build_object(
			'organizationId', "backfilled"."organization_id"::text,
			'theme', 'requestport',
			'density', 'ultra-compact',
			'mode', 'system'),
		'{}'::jsonb
	FROM "backfilled"
	RETURNING "id"
)
INSERT INTO "public"."outbox" ("event_id")
SELECT "id" FROM "seeded";
