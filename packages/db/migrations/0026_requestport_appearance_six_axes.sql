-- requestport: this migration must be the last one applied in its transaction
-- Plan 13, console redesign R1 (ruling 255): appearance becomes six axes, every
-- stock cue-ui 0.29.0 theme is allowed, density gains cue-ui's `compact`, and
-- a new organization starts on the cue theme, normal density, the system's
-- mode, and the typeface, Look and surface of the theme's own Look (`match`).
-- Expand-only: it adds three columns to each appearance table with their
-- check constraints, widens the two theme checks and the two density checks
-- under their existing names, replaces the body of 0014's owner-activation
-- trigger function, and moves the organizations whose defaults are still
-- exactly 0014's seed. No column, constraint, table or row is removed, and
-- person preferences are not changed.
--
-- The density checks. Each admits 'compact' between 'ultra-compact' and
-- 'normal', on both tables; cue-ui's 'ultra-large' is not admitted. Every
-- value the old checks admitted is still admitted, so no stored row can fail
-- the new ones.
--
-- The columns. font, look and paint accept `match` or one of cue-ui's names
-- (packages/db/src/schema/appearance.ts holds the vocabularies, the domain
-- re-declares them, and a test holds the two equal). On
-- organization_appearance_defaults each is NOT NULL DEFAULT 'match', so every
-- existing row reads `match` on all three; on user_appearance_preferences each
-- is nullable, and NULL keeps the organization's value, as on the other three.
--
-- The trigger body. Only the seeded values change: 'cue', 'normal', 'system'
-- and `match` three times, in the row and in the initialization event's data.
-- It keeps 0019's SECURITY DEFINER and pinned search_path; CREATE OR REPLACE
-- keeps the function's owner (requestport_definer) and its ACL, and the
-- trigger itself is not touched.
--
-- The backfill. A row still exactly 0014's seed — version 1, 'requestport',
-- 'ultra-compact', 'system', and `match` on the three new axes, which every
-- existing row has — moves to the new defaults the way the appearance command
-- writes an update: version + 1, updated_at now, and one
-- appearance.organization_defaults_updated.v1 event at the new version, with
-- the sorted changed fields and the before and after values, plus its outbox
-- row. Its actor is the fixed service identity 0014's initializer uses, its
-- correlation and causation are derived from the organization UUID alone, and
-- last_updated_by_user_id is set to NULL, because no member made this change.
-- A row anyone has edited — any version above 1, or any other value — is left
-- as it is, and so is a version-1 row whose aggregate already has an event
-- past version 1: its row and its stream disagree, and the update's version-2
-- event would collide with the one there (domain_events_aggregate_version_unique).
-- No command writes that state; test fixtures that adopt an aggregate in a
-- schema of their own do (measured on a track database, 2026-10-25), and a
-- migration that refused them would refuse that database. No security audit row is written: the audit trail records a member
-- or credential exercising authority, and 0014's initialization wrote none for
-- the same reason.
--
-- Where the locks are. organization_members is locked first, in the mode 0014
-- used, so no owner activation can run its trigger between this migration's
-- reads: one that started earlier finishes, and is seen by the backfill,
-- before the lock is granted; one that starts later waits, and then runs the
-- new body. Each ALTER TABLE then takes ACCESS EXCLUSIVE on its appearance
-- table, held to the commit. The line below bounds every wait at 5 seconds, as
-- 0024 bounds its own: a timeout rolls the apply back whole, so it can simply
-- be run again.
--
-- The first line marks it (scripts/migration-support.mjs,
-- LAST_IN_TRANSACTION_MARKER): a later migration applied in the same
-- transaction would inherit this lock_timeout and run while these locks are
-- held.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
LOCK TABLE "public"."organization_members" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
ALTER TABLE "organization_appearance_defaults" DROP CONSTRAINT "organization_appearance_defaults_theme_check";--> statement-breakpoint
ALTER TABLE "organization_appearance_defaults" ADD CONSTRAINT "organization_appearance_defaults_theme_check" CHECK ("organization_appearance_defaults"."theme" in ('requestport', 'cue', 'terminal', 'signal', 'venu', 'hivehub', 'dusk', 'luma', 'snuffle', 'command', 'graphite', 'kiln', 'ledger', 'monolith', 'porcelain', 'prism', 'quotamate', 'tender', 'zine'));--> statement-breakpoint
ALTER TABLE "user_appearance_preferences" DROP CONSTRAINT "user_appearance_preferences_theme_check";--> statement-breakpoint
ALTER TABLE "user_appearance_preferences" ADD CONSTRAINT "user_appearance_preferences_theme_check" CHECK ("user_appearance_preferences"."theme" is null or "user_appearance_preferences"."theme" in ('requestport', 'cue', 'terminal', 'signal', 'venu', 'hivehub', 'dusk', 'luma', 'snuffle', 'command', 'graphite', 'kiln', 'ledger', 'monolith', 'porcelain', 'prism', 'quotamate', 'tender', 'zine'));--> statement-breakpoint
ALTER TABLE "organization_appearance_defaults" DROP CONSTRAINT "organization_appearance_defaults_density_check";--> statement-breakpoint
ALTER TABLE "organization_appearance_defaults" ADD CONSTRAINT "organization_appearance_defaults_density_check" CHECK ("organization_appearance_defaults"."density" in ('ultra-compact', 'compact', 'normal', 'large'));--> statement-breakpoint
ALTER TABLE "user_appearance_preferences" DROP CONSTRAINT "user_appearance_preferences_density_check";--> statement-breakpoint
ALTER TABLE "user_appearance_preferences" ADD CONSTRAINT "user_appearance_preferences_density_check" CHECK ("user_appearance_preferences"."density" is null or "user_appearance_preferences"."density" in ('ultra-compact', 'compact', 'normal', 'large'));--> statement-breakpoint
ALTER TABLE "organization_appearance_defaults" ADD COLUMN "font" text DEFAULT 'match' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_appearance_defaults" ADD COLUMN "look" text DEFAULT 'match' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_appearance_defaults" ADD COLUMN "paint" text DEFAULT 'match' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_appearance_preferences" ADD COLUMN "font" text;--> statement-breakpoint
ALTER TABLE "user_appearance_preferences" ADD COLUMN "look" text;--> statement-breakpoint
ALTER TABLE "user_appearance_preferences" ADD COLUMN "paint" text;--> statement-breakpoint
ALTER TABLE "organization_appearance_defaults" ADD CONSTRAINT "organization_appearance_defaults_font_check" CHECK ("organization_appearance_defaults"."font" in ('match', 'geist', 'geist-mono', 'inter', 'inter-source', 'plex', 'dm', 'calsans', 'fraunces-mono', 'system'));--> statement-breakpoint
ALTER TABLE "organization_appearance_defaults" ADD CONSTRAINT "organization_appearance_defaults_look_check" CHECK ("organization_appearance_defaults"."look" in ('match', 'console', 'editorial', 'marketing', 'graphite', 'tender', 'zine', 'kiln', 'porcelain', 'ledger', 'command', 'monolith', 'prism'));--> statement-breakpoint
ALTER TABLE "organization_appearance_defaults" ADD CONSTRAINT "organization_appearance_defaults_paint_check" CHECK ("organization_appearance_defaults"."paint" in ('match', 'none', 'halo', 'hatch', 'lift', 'frost', 'bevel', 'grain', 'plume', 'matte', 'glaze'));--> statement-breakpoint
ALTER TABLE "user_appearance_preferences" ADD CONSTRAINT "user_appearance_preferences_font_check" CHECK ("user_appearance_preferences"."font" is null or "user_appearance_preferences"."font" in ('match', 'geist', 'geist-mono', 'inter', 'inter-source', 'plex', 'dm', 'calsans', 'fraunces-mono', 'system'));--> statement-breakpoint
ALTER TABLE "user_appearance_preferences" ADD CONSTRAINT "user_appearance_preferences_look_check" CHECK ("user_appearance_preferences"."look" is null or "user_appearance_preferences"."look" in ('match', 'console', 'editorial', 'marketing', 'graphite', 'tender', 'zine', 'kiln', 'porcelain', 'ledger', 'command', 'monolith', 'prism'));--> statement-breakpoint
ALTER TABLE "user_appearance_preferences" ADD CONSTRAINT "user_appearance_preferences_paint_check" CHECK ("user_appearance_preferences"."paint" is null or "user_appearance_preferences"."paint" in ('match', 'none', 'halo', 'hatch', 'lift', 'frost', 'bevel', 'grain', 'plume', 'matte', 'glaze'));--> statement-breakpoint
-- 0019's body, with the new seed: the values below are its only change.
CREATE OR REPLACE FUNCTION public.requestport_initialize_organization_appearance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
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
		("organization_id", "theme", "density", "mode", "font", "look", "paint",
		 "last_updated_by_user_id", "version")
	VALUES
		(NEW."organization_id", 'cue', 'normal', 'system', 'match', 'match',
		 'match', NEW."user_id", 1)
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
			'theme', 'cue',
			'density', 'normal',
			'mode', 'system',
			'font', 'match',
			'look', 'match',
			'paint', 'match'),
		 '{}'::jsonb);

	INSERT INTO "public"."outbox" ("event_id") VALUES (seeded_event_id);

	RETURN NULL;
END;
$$;--> statement-breakpoint
WITH "reseeded" AS (
	UPDATE "public"."organization_appearance_defaults" "d"
	SET "theme" = 'cue',
		"density" = 'normal',
		"last_updated_by_user_id" = NULL,
		"version" = "d"."version" + 1,
		"updated_at" = now()
	WHERE "d"."version" = 1
		AND "d"."theme" = 'requestport'
		AND "d"."density" = 'ultra-compact'
		AND "d"."mode" = 'system'
		AND "d"."font" = 'match'
		AND "d"."look" = 'match'
		AND "d"."paint" = 'match'
		AND NOT EXISTS (
			SELECT 1 FROM "public"."domain_events" "e"
			WHERE "e"."organization_id" = "d"."organization_id"
				AND "e"."aggregate_type" = 'organization_appearance'
				AND "e"."aggregate_id" = "d"."aggregate_id"
				AND "e"."aggregate_version" > 1)
	RETURNING "d"."organization_id", "d"."aggregate_id", "d"."version"
), "recorded" AS (
	INSERT INTO "public"."domain_events"
		("id", "organization_id", "aggregate_type", "aggregate_id",
		 "aggregate_version", "type", "schema_version", "actor",
		 "correlation_id", "causation_id", "data", "links")
	SELECT gen_random_uuid(), "reseeded"."organization_id",
		'organization_appearance', "reseeded"."aggregate_id",
		"reseeded"."version",
		'appearance.organization_defaults_updated.v1', 1,
		'{"type": "service", "id": "requestport-appearance-default-initializer"}'::jsonb,
		'appearance-default-reseed:' || "reseeded"."organization_id"::text,
		'appearance-default-reseed:' || "reseeded"."organization_id"::text,
		jsonb_build_object(
			'organizationId', "reseeded"."organization_id"::text,
			'changedFields', '["density", "theme"]'::jsonb,
			'before', '{"theme": "requestport", "density": "ultra-compact", "mode": "system", "font": "match", "look": "match", "paint": "match"}'::jsonb,
			'after', '{"theme": "cue", "density": "normal", "mode": "system", "font": "match", "look": "match", "paint": "match"}'::jsonb),
		'{}'::jsonb
	FROM "reseeded"
	RETURNING "id"
)
INSERT INTO "public"."outbox" ("event_id")
SELECT "id" FROM "recorded";
