CREATE OR REPLACE FUNCTION "public"."requestport_guard_user_signup"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	active_invitation_id uuid;
BEGIN
	NEW."email" := lower(btrim(NEW."email"));

	-- FOR UPDATE serializes invitation revocation with consumption. Explicitly
	-- recheck with clock_timestamp() after each lock is acquired: PostgreSQL
	-- does not re-evaluate a volatile time predicate after an unchanged row lock.
	FOR active_invitation_id IN
		SELECT "id"
		FROM "public"."invitations"
		WHERE lower("normalized_email") = NEW."email"
			AND "accepted_at" IS NULL
			AND "revoked_at" IS NULL
			AND "expires_at" > clock_timestamp()
		ORDER BY "expires_at", "id"
		FOR UPDATE
	LOOP
		PERFORM 1
		FROM "public"."invitations"
		WHERE "id" = active_invitation_id
			AND "accepted_at" IS NULL
			AND "revoked_at" IS NULL
			AND "expires_at" > clock_timestamp();

		IF FOUND THEN
			UPDATE "public"."invitations"
			SET "accepted_at" = clock_timestamp()
			WHERE "id" = active_invitation_id;
			RETURN NEW;
		END IF;
	END LOOP;

	-- FOR SHARE deliberately blocks UPDATE/DELETE. FOR KEY SHARE would permit
	-- a concurrent non-key status or expiry update. Recheck database time after
	-- the lock to deny an insert that waited past the row's expiry.
	PERFORM 1
	FROM "public"."signup_allowlist"
	WHERE lower("normalized_email") = NEW."email"
		AND "status" = 'active'
		AND ("expires_at" IS NULL OR "expires_at" > clock_timestamp())
	FOR SHARE;

	IF FOUND THEN
		PERFORM 1
		FROM "public"."signup_allowlist"
		WHERE lower("normalized_email") = NEW."email"
			AND "status" = 'active'
			AND ("expires_at" IS NULL OR "expires_at" > clock_timestamp());

		IF FOUND THEN
			RETURN NEW;
		END IF;
	END IF;

	RAISE EXCEPTION USING
		ERRCODE = 'P0001',
		MESSAGE = 'requestport_signup_disabled',
		CONSTRAINT = 'requestport_user_signup_eligibility_guard';
END;
$$;
