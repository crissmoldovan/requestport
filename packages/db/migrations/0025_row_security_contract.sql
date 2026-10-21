-- requestport: this migration must be the last one applied in its transaction
-- Plan 13, Track I.2, step 5: the contract release of row-level security
-- (docs/implementation/plans/2026-09-27-13/manifest-i2.md §3 step 5, as
-- ruling 215 item 11 amends it; r9-rulings.md, ruling 221 item 3;
-- track-i2.md, "I.2 step 5, the survey (2026-10-18)" §(b) to §(d)).
--
-- Three changes, each checked by the last statement:
--
-- 1. The fourteen definer functions that 0019 and 0021 granted to the
--    migrating role, CURRENT_USER, until this step: 0019's twelve lookups
--    (manifest-i2.md §2.5, "until step 5") and 0021's two credential locks
--    ("until the contract steps"). Each is revoked from CURRENT_USER,
--    whatever the migrating role is named, and from requestport_definer, the
--    functions' owner, whose own entry the migrating role inherits through
--    0019's membership (GRANT requestport_definer TO CURRENT_USER WITH
--    INHERIT TRUE). With the first revoke alone it still executes every one
--    of them (measured on an owner-shaped role, survey §(d), candidate A);
--    0023 did the same for the worker's seventeen (ruling 215 items 1 and
--    11). No owner-connected path calls any of the fourteen: not the
--    operator CLI, not the launcher's integrity check, not requestport
--    start's provisioning, and not any migration's body (survey §(d)). The
--    application group keeps EXECUTE on all fourteen, and the tenant
--    processor on the two locks. A body still runs as requestport_definer,
--    and no body calls one of the fourteen. An owner can always grant
--    itself EXECUTE again. No CASCADE: no entry here carries a grant option.
-- 2. FORCE ROW LEVEL SECURITY on the 59 tenant tables, the tables to which
--    0019 gave a requestport_tenant policy. user_appearance_preferences, the
--    global table that carries D1's user policy, is not a tenant table and is
--    not forced. FORCE applies a table's policies to the table's owner too,
--    unless the owner bypasses row security, as a superuser or a BYPASSRLS
--    role does. Production's owner has BYPASSRLS; requestport start refuses
--    an owner that is neither a superuser nor BYPASSRLS before it migrates
--    anything; the local requestport role and PGlite's are superusers. Every
--    definer body runs as requestport_definer, which has BYPASSRLS and owns no
--    table. So none of those is affected; FORCE binds an owner that does not
--    bypass row security (manifest-i2.md §2.2).
-- 3. The application group's direct SELECT on signup_allowlist (D13): since
--    step 2 its one read is signup_allowlist_eligibility, one of the
--    fourteen.
--
-- A superuser is unaffected by part 1, because a superuser passes every
-- privilege check.
--
-- Where the locks are (0019's pattern; survey §(b)). Each FORCE takes ACCESS
-- EXCLUSIVE on its table, held to the commit (measured). Every statement
-- that takes a table lock is therefore in one DO block, after the function
-- revokes, so Drizzle's migrator sends it as one query on every driver (a
-- bare multi-statement chunk is refused by PGlite's extended protocol). The
-- block takes all 59 locks in its first statement, NOWAIT, and tries again
-- after a short pause rather than wait, so this migration never waits for a
-- table lock another transaction holds, and never closes a deadlock cycle
-- through one. The table REVOKE comes after the locks, in the same block: it
-- takes no lock on signup_allowlist, which is not locked here, but rewrites
-- its pg_class row, and nothing after it in this transaction locks that
-- table. Before the block, each REVOKE changes one function's ACL in pg_proc,
-- which no execution of the function waits for, nor it for one (measured
-- for 0023). After it, the last statement only reads the catalogue.
--
-- The first line marks it (scripts/migration-support.mjs,
-- LAST_IN_TRANSACTION_MARKER). Drizzle's migrator applies every pending
-- migration in one transaction, so a migration after this one in the same
-- run would inherit the lock_timeout below and would run while the 59
-- locks are held, and its first lock wait could close the deadlock cycle the
-- block exists to prevent. Being last, what follows the block is the closing
-- check, the journal insert and the commit. What can still wait is none of
-- what a request holds: a function's or a table's catalogue row waits only
-- for another update of that row, and the journal insert only for another
-- migrator. The line below gives each up after 100 ms, as 0019's does.
--
-- A REVOKE that the migrating role cannot act on only warns ("no privileges
-- could be revoked"). So the last statement checks the result, and its
-- exception rolls the migration back:
-- - each function's ACL is exactly its groups' entries, granted by the
--   owner;
-- - a migrating role that is not a superuser cannot execute any of the
--   fourteen by any path. With each ACL exactly its groups', the one path
--   left is an inheriting membership in one of those groups, so the refusal
--   names the groups and the setting that gives such a membership: a server
--   whose createrole_self_grant includes inherit gives a CREATEROLE role that
--   is not a superuser an inheriting membership in each role it creates
--   (ruling 215 item 10). PostgreSQL's default is empty;
-- - every table in public that carries a requestport_tenant policy is
--   forced;
-- - the application group holds no SELECT on signup_allowlist, on the table
--   or any column, directly or through PUBLIC.
SET LOCAL lock_timeout = '100ms';--> statement-breakpoint
-- Part 1: the grants 0019 and 0021 made to the migrating role.
REVOKE EXECUTE ON FUNCTION requestport_private.resolve_oauth_grant(text, text, text) FROM CURRENT_USER;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.list_oauth_grant_binding_fingerprints(text, text) FROM CURRENT_USER;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.has_usable_oauth_grant(text, text) FROM CURRENT_USER;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.revoke_user_client_oauth_grants(text, text) FROM CURRENT_USER;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.resolve_api_key_credential(text, text) FROM CURRENT_USER;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.resolve_operator_credential(text) FROM CURRENT_USER;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.consume_slack_oauth_state(text) FROM CURRENT_USER;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.lock_slack_action_token(text, text, text, text) FROM CURRENT_USER;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.record_provider_callback(text, text, text, timestamptz, text, text) FROM CURRENT_USER;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.invitation_eligibility(text) FROM CURRENT_USER;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.signup_allowlist_eligibility(text) FROM CURRENT_USER;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.active_memberships() FROM CURRENT_USER;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.lock_live_api_key(text) FROM CURRENT_USER;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.lock_live_oauth_client(text) FROM CURRENT_USER;--> statement-breakpoint
-- Part 2: the owner's own entry, through which the migrating role
-- inherits EXECUTE (0019's membership).
REVOKE EXECUTE ON FUNCTION requestport_private.resolve_oauth_grant(text, text, text) FROM requestport_definer;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.list_oauth_grant_binding_fingerprints(text, text) FROM requestport_definer;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.has_usable_oauth_grant(text, text) FROM requestport_definer;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.revoke_user_client_oauth_grants(text, text) FROM requestport_definer;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.resolve_api_key_credential(text, text) FROM requestport_definer;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.resolve_operator_credential(text) FROM requestport_definer;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.consume_slack_oauth_state(text) FROM requestport_definer;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.lock_slack_action_token(text, text, text, text) FROM requestport_definer;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.record_provider_callback(text, text, text, timestamptz, text, text) FROM requestport_definer;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.invitation_eligibility(text) FROM requestport_definer;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.signup_allowlist_eligibility(text) FROM requestport_definer;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.active_memberships() FROM requestport_definer;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.lock_live_api_key(text) FROM requestport_definer;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.lock_live_oauth_client(text) FROM requestport_definer;--> statement-breakpoint
-- Every table lock, then FORCE and the table revoke, in this one DO block
-- (see the header).
DO $$
DECLARE
	gives_up_at timestamptz := pg_catalog.clock_timestamp() + interval '20 seconds';
BEGIN
	-- The 59 tenant tables, locked in one statement, NOWAIT. A try that finds
	-- any of them held fails at once; its subtransaction is rolled back,
	-- releasing whatever it took, and the next try comes after a pause of
	-- 10-100 ms. After 20 seconds without a free moment it gives up with
	-- 55P03 and rolls back whole.
	LOOP
		BEGIN
			LOCK TABLE
				public."organizations", public."agent_credentials",
				public."agent_installations", public."agent_oauth_grants",
				public."agent_principals", public."answers", public."artifacts",
				public."completion_reports", public."domain_events",
				public."email_deliveries", public."import_apply_reports",
				public."import_conflicts", public."import_entry_applications",
				public."import_manifest_entries", public."import_runs",
				public."import_sources", public."import_task_dispatches",
				public."invitations", public."lanes", public."legacy_aliases",
				public."legacy_mappings", public."machine_workspaces",
				public."message_mentions", public."messages",
				public."notification_intents", public."operator_credentials",
				public."organization_appearance_defaults",
				public."organization_members", public."project_aliases",
				public."project_members", public."project_repositories",
				public."project_sequences", public."projects", public."questions",
				public."request_relationships", public."requests",
				public."retention_holds", public."retention_tombstones",
				public."routing_rules", public."security_audit_records",
				public."slack_action_tokens", public."slack_deliveries",
				public."slack_installations", public."slack_oauth_states",
				public."slack_routes", public."slack_user_mappings",
				public."source_artifacts", public."source_snapshots",
				public."state_transitions", public."user_request_read_states",
				public."webhook_deliveries", public."webhook_subscriptions",
				public."work_sessions", public."work_updates", public."outbox",
				public."request_acceptance_criteria", public."request_labels",
				public."slack_delivery_operations", public."webhook_attempts"
				IN ACCESS EXCLUSIVE MODE NOWAIT;
			EXIT;
		EXCEPTION WHEN lock_not_available THEN
			IF pg_catalog.clock_timestamp() >= gives_up_at THEN
				RAISE EXCEPTION 'requestport: the row-level security contract could not lock its 59 tables at once in 20 seconds of tries; nothing was applied, and it can be run again'
					USING ERRCODE = '55P03';
			END IF;
			PERFORM pg_catalog.pg_sleep(0.01 + pg_catalog.random() * 0.09);
		END;
	END LOOP;
	ALTER TABLE public."organizations" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."agent_credentials" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."agent_installations" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."agent_oauth_grants" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."agent_principals" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."answers" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."artifacts" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."completion_reports" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."domain_events" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."email_deliveries" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."import_apply_reports" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."import_conflicts" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."import_entry_applications" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."import_manifest_entries" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."import_runs" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."import_sources" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."import_task_dispatches" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."invitations" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."lanes" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."legacy_aliases" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."legacy_mappings" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."machine_workspaces" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."message_mentions" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."messages" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."notification_intents" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."operator_credentials" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."organization_appearance_defaults" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."organization_members" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."project_aliases" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."project_members" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."project_repositories" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."project_sequences" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."projects" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."questions" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."request_relationships" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."requests" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."retention_holds" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."retention_tombstones" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."routing_rules" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."security_audit_records" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."slack_action_tokens" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."slack_deliveries" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."slack_installations" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."slack_oauth_states" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."slack_routes" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."slack_user_mappings" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."source_artifacts" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."source_snapshots" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."state_transitions" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."user_request_read_states" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."webhook_deliveries" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."webhook_subscriptions" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."work_sessions" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."work_updates" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."outbox" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."request_acceptance_criteria" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."request_labels" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."slack_delivery_operations" FORCE ROW LEVEL SECURITY;
	ALTER TABLE public."webhook_attempts" FORCE ROW LEVEL SECURITY;
	-- D13: the application's one read of signup_allowlist is
	-- signup_allowlist_eligibility. The definer keeps its SELECT.
	REVOKE SELECT ON public.signup_allowlist FROM requestport_application;
END $$;--> statement-breakpoint
-- The postcondition. The list is part 1's fourteen, each with its groups.
DO $$
DECLARE
	contract record;
	acl text[];
	expected text[];
	unforced text;
	migrating_superuser constant boolean := coalesce(
		(SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user),
		false
	);
BEGIN
	FOR contract IN
		SELECT f.signature::pg_catalog.regprocedure AS fn, f.groups
		FROM (VALUES
			('requestport_private.resolve_oauth_grant(text, text, text)', ARRAY['requestport_application']),
			('requestport_private.list_oauth_grant_binding_fingerprints(text, text)', ARRAY['requestport_application']),
			('requestport_private.has_usable_oauth_grant(text, text)', ARRAY['requestport_application']),
			('requestport_private.revoke_user_client_oauth_grants(text, text)', ARRAY['requestport_application']),
			('requestport_private.resolve_api_key_credential(text, text)', ARRAY['requestport_application']),
			('requestport_private.resolve_operator_credential(text)', ARRAY['requestport_application']),
			('requestport_private.consume_slack_oauth_state(text)', ARRAY['requestport_application']),
			('requestport_private.lock_slack_action_token(text, text, text, text)', ARRAY['requestport_application']),
			('requestport_private.record_provider_callback(text, text, text, timestamptz, text, text)', ARRAY['requestport_application']),
			('requestport_private.invitation_eligibility(text)', ARRAY['requestport_application']),
			('requestport_private.signup_allowlist_eligibility(text)', ARRAY['requestport_application']),
			('requestport_private.active_memberships()', ARRAY['requestport_application']),
			('requestport_private.lock_live_api_key(text)', ARRAY['requestport_tenant_processor', 'requestport_application']),
			('requestport_private.lock_live_oauth_client(text)', ARRAY['requestport_tenant_processor', 'requestport_application'])
		) AS f (signature, groups)
	LOOP
		SELECT p.proacl::text[] INTO acl
		FROM pg_catalog.pg_proc p
		WHERE p.oid = contract.fn;
		SELECT pg_catalog.array_agg(g || '=X/requestport_definer') INTO expected
		FROM pg_catalog.unnest(contract.groups) AS g;
		IF acl IS NULL OR NOT (acl @> expected AND acl <@ expected) THEN
			RAISE EXCEPTION 'requestport: % is executable by %, expected exactly %', contract.fn, acl, expected;
		END IF;
		IF NOT migrating_superuser
			AND pg_catalog.has_function_privilege(current_user, contract.fn, 'EXECUTE') THEN
			RAISE EXCEPTION 'requestport: the migrating role % can still execute %, through an inheriting membership in one of %. A server whose createrole_self_grant includes inherit gives a role that is not a superuser such a membership in each role it creates: take the inherit option off it, or migrate as a role without one.', current_user, contract.fn, contract.groups;
		END IF;
	END LOOP;
	SELECT pg_catalog.string_agg(c.relname::text, ', ' ORDER BY c.relname) INTO unforced
	FROM pg_catalog.pg_class c
	JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
	WHERE n.nspname = 'public'
		AND NOT c.relforcerowsecurity
		AND EXISTS (
			SELECT 1 FROM pg_catalog.pg_policy p
			WHERE p.polrelid = c.oid AND p.polname = 'requestport_tenant'
		);
	IF unforced IS NOT NULL THEN
		RAISE EXCEPTION 'requestport: tenant tables with row security not forced: %', unforced;
	END IF;
	IF pg_catalog.has_table_privilege('requestport_application', 'public.signup_allowlist', 'SELECT')
		OR pg_catalog.has_any_column_privilege('requestport_application', 'public.signup_allowlist', 'SELECT') THEN
		RAISE EXCEPTION 'requestport: requestport_application can still read public.signup_allowlist directly';
	END IF;
END $$;
