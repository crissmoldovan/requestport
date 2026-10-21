CREATE OR REPLACE FUNCTION "public"."requestport_guard_user_signup"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	active_invitation_id uuid;
BEGIN
	NEW."email" := lower(btrim(NEW."email"));

	-- FOR UPDATE serializes invitation revocation with consumption. A waiting
	-- READ COMMITTED statement rechecks the active predicate after the lock.
	SELECT "id"
	INTO active_invitation_id
	FROM "public"."invitations"
	WHERE lower("normalized_email") = NEW."email"
		AND "accepted_at" IS NULL
		AND "revoked_at" IS NULL
		AND "expires_at" > clock_timestamp()
	ORDER BY "expires_at", "id"
	FOR UPDATE
	LIMIT 1;

	IF active_invitation_id IS NOT NULL THEN
		UPDATE "public"."invitations"
		SET "accepted_at" = clock_timestamp()
		WHERE "id" = active_invitation_id;
		RETURN NEW;
	END IF;

	-- FOR SHARE deliberately blocks UPDATE/DELETE. FOR KEY SHARE would still
	-- permit a concurrent non-key status or expiry update and is insufficient.
	PERFORM 1
	FROM "public"."signup_allowlist"
	WHERE lower("normalized_email") = NEW."email"
		AND "status" = 'active'
		AND ("expires_at" IS NULL OR "expires_at" > clock_timestamp())
	FOR SHARE;

	IF FOUND THEN
		RETURN NEW;
	END IF;

	RAISE EXCEPTION USING
		ERRCODE = 'P0001',
		MESSAGE = 'requestport_signup_disabled',
		CONSTRAINT = 'requestport_user_signup_eligibility_guard';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "requestport_user_signup_eligibility_guard"
BEFORE INSERT ON "user"
FOR EACH ROW
EXECUTE FUNCTION "public"."requestport_guard_user_signup"();
