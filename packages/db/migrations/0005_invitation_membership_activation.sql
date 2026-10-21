CREATE OR REPLACE FUNCTION "public"."requestport_guard_user_signup"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	active_invitation record;
	accepted_invitation boolean := false;
	membership_accepted_at timestamp with time zone;
BEGIN
	NEW."email" := lower(btrim(NEW."email"));

	-- Lock every candidate in one deterministic order. A concurrent revocation
	-- that commits first removes its row from this READ COMMITTED result; a
	-- signup that locks first keeps revocation behind the user transaction.
	FOR active_invitation IN
		SELECT "id", "organization_id", "role"
		FROM "public"."invitations"
		WHERE lower("normalized_email") = NEW."email"
			AND "accepted_at" IS NULL
			AND "revoked_at" IS NULL
			AND "expires_at" > clock_timestamp()
		ORDER BY "expires_at", "id"
		FOR UPDATE
	LOOP
		-- PostgreSQL does not re-evaluate a volatile time predicate after an
		-- unchanged row lock, so expiry is checked again after the lock.
		PERFORM 1
		FROM "public"."invitations"
		WHERE "id" = active_invitation."id"
			AND "accepted_at" IS NULL
			AND "revoked_at" IS NULL
			AND "expires_at" > clock_timestamp();

		IF FOUND THEN
			membership_accepted_at := clock_timestamp();

			INSERT INTO "public"."organization_members"
				("organization_id", "user_id", "role", "status", "joined_at",
				 "created_at", "updated_at")
			VALUES
				(active_invitation."organization_id", NEW."id",
				 active_invitation."role", 'active', membership_accepted_at,
				 membership_accepted_at, membership_accepted_at)
			ON CONFLICT ("organization_id", "user_id")
			DO UPDATE SET
				"role" = EXCLUDED."role",
				"status" = 'active',
				"joined_at" = membership_accepted_at,
				"updated_at" = membership_accepted_at;

			UPDATE "public"."invitations"
			SET "accepted_at" = membership_accepted_at
			WHERE "id" = active_invitation."id";

			accepted_invitation := true;
		END IF;
	END LOOP;

	IF accepted_invitation THEN
		RETURN NEW;
	END IF;

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
