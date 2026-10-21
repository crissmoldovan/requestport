-- Plan 13, Track I.2b, step b2′: the two live-credential locks, as an expand
-- (the driver's ruling of 2026-09-30, option 2; manifest-i2.md §5.1 rows 18
-- and 19, §2.5.0; track-i2.md, "b2, the packages/db half (2026-09-30)").
--
-- An agent's import application authorises through
-- lockActiveApiKeyAuthorization and lockActiveOAuthAuthorization
-- (packages/db/src/repositories/agent-authorization.ts), and each joined a
-- Better Auth table, apikey or oauth_client, and locked its row FOR SHARE.
-- §5.1 refuses the tenant processor both tables, so as the processor that
-- path failed with 42501. These two functions answer, for one row, exactly
-- the liveness predicate the join applied, take FOR SHARE on that row, and
-- say whether a live row was found and locked. A row lock taken in a
-- function belongs to the caller's transaction, so it is held to that
-- transaction's end, as the join's was: a concurrent revocation waits for it.
-- From I.2b's b2 on, the helpers call them in place of the join, for the
-- application's command path and the worker's import application alike. This
-- migration is applied ahead of b2 (step b2′), and until b2 merges nothing
-- calls them.
--
-- Applied to production it adds two functions in requestport_private, owned
-- by requestport_definer, executable by the processor, the application and
-- the migrating role, and gives requestport_definer UPDATE (id) on apikey and
-- oauth_client, which FOR SHARE needs (0019 gave it SELECT alone). It changes
-- no table's columns, rows or policies, no role, and no existing function.
--
-- Where the locks are (track-i2.md, "b2, the packages/db half": the lock
-- probe). Both functions are LANGUAGE plpgsql, whose body is parsed but not
-- planned when it is created, so creating them locks no table. The one table
-- privilege is a column grant: it rewrites the columns' pg_attribute rows and
-- leaves the table's pg_class row alone, so a VACUUM or ANALYZE of apikey or
-- oauth_client does not wait for this migration's commit, as one waits for
-- 0020's table GRANTs. That wait is why 0020 must be the last migration in
-- its transaction; nothing here needs the marker, and this file does not
-- carry it. It is applied in a run after 0020's, because 0020's marker
-- refuses anything pending after it.
--
-- 18: the join's predicate on apikey, which is keyed by id.
CREATE OR REPLACE FUNCTION requestport_private.lock_live_api_key(p_api_key_id text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
	PERFORM 1
	FROM public.apikey k
	WHERE k.id = p_api_key_id
		AND k.enabled = true
		AND k.expires_at > clock_timestamp()
	FOR SHARE;
	RETURN FOUND;
END;
$$;--> statement-breakpoint
-- 19: the join's predicate on oauth_client, which is keyed by client_id.
CREATE OR REPLACE FUNCTION requestport_private.lock_live_oauth_client(p_client_id text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
	PERFORM 1
	FROM public.oauth_client c
	WHERE c.client_id = p_client_id
		AND c.disabled = false
	FOR SHARE;
	RETURN FOUND;
END;
$$;--> statement-breakpoint
-- §2.5.0 item 4: nobody but the roles named below may execute these.
REVOKE EXECUTE ON FUNCTION requestport_private.lock_live_api_key(text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.lock_live_oauth_client(text) FROM PUBLIC;--> statement-breakpoint
-- §2.2: the new owner needs CREATE on the schema while ownership moves, and
-- only then (0019's P3).
GRANT CREATE ON SCHEMA requestport_private TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.lock_live_api_key(text) OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.lock_live_oauth_client(text) OWNER TO requestport_definer;--> statement-breakpoint
REVOKE CREATE ON SCHEMA requestport_private FROM requestport_definer;--> statement-breakpoint
-- After ownership moved, never before (0019). The processor and the
-- application share the helpers that call these; the migrating role keeps
-- EXECUTE until the contract steps, because the code calls them while
-- production still connects as the owner (§2.2, §5.2).
GRANT EXECUTE ON FUNCTION requestport_private.lock_live_api_key(text) TO requestport_tenant_processor, requestport_application, CURRENT_USER;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.lock_live_oauth_client(text) TO requestport_tenant_processor, requestport_application, CURRENT_USER;--> statement-breakpoint
-- D3: FOR SHARE needs UPDATE on at least one column (D19, P10). A column
-- grant, not a table grant: see the header on why that matters.
GRANT UPDATE (id) ON public.apikey, public.oauth_client TO requestport_definer;
