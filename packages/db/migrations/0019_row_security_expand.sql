-- requestport: this migration must be the last one applied in its transaction
-- Plan 13, Track I.2, step 1: the expand release of row-level security
-- (docs/implementation/plans/2026-09-27-13/manifest-i2.md §2, §3 step 1).
--
-- The line above marks it (scripts/migration-support.mjs,
-- LAST_IN_TRANSACTION_MARKER). Drizzle's migrator applies every pending
-- migration in one transaction, so a migration after this one in the same
-- run would inherit the lock_timeout below and run while this one's 61 table
-- locks are held, and its first lock wait could close the deadlock cycle the
-- block at the end exists to prevent. Two guards keep it last: the production
-- launcher refuses to apply it with another migration pending after it, and
-- the gate's migration-state step fails while the journal has an entry after
-- it and production-migration-state.json does not record it as applied.
--
-- Production connects as its owner, which owns every table and has BYPASSRLS,
-- so the policies below do not apply to it; nothing in the application reads
-- any of this until step 2. Three things here act on production the moment it
-- is applied, and packages/db's tests check each (row-security.*.test.ts for
-- the first two, migration.test.ts for the third):
--   * the three trigger functions below become SECURITY DEFINER, owned by
--     requestport_definer, which has BYPASSRLS and the grants their bodies use;
--   * the migrating role keeps EXECUTE on every definer lookup (§2.2);
--   * every lock this migration waits for is bounded by the line below.
--
-- Where the locks are (track-i2.md §11, §12, §13). Every statement that takes
-- ACCESS EXCLUSIVE on a table is in the last chunk, one DO block, so Drizzle's
-- migrator sends it as one query on every driver (a bare multi-statement
-- chunk is refused by PGlite's extended protocol). That block takes all 61 of
-- those locks in its first statement, NOWAIT, and tries again after a short
-- pause rather than wait, so this migration never waits for a table lock
-- another transaction holds, and never closes a deadlock cycle through one. Each
-- lock is held from there to the commit. Only because this is the last
-- migration applied in its transaction (the marker above) is that commit what
-- Drizzle sends after that query's reply and the journal insert: a couple of
-- round trips, not one per statement. Every grant on a table is in that block
-- too, after the locks: a table GRANT takes no lock but rewrites the table's
-- pg_class row, and a VACUUM or ANALYZE that then reaches its own update of
-- that row waits for this transaction while holding SHARE UPDATE EXCLUSIVE,
-- so an ENABLE on the same table after the GRANT would deadlock with it.
-- Before the block, the
-- grants and revokes are on roles, schemas and functions, ALTER FUNCTION
-- changes only the function, and creating a LANGUAGE sql function checks its
-- body, which takes the locks its statements would (ACCESS SHARE, ROW SHARE,
-- ROW EXCLUSIVE); none of those conflicts with a read, a row lock or a write.
-- What it can still wait for is none of what a request's reads and writes
-- hold: those weak locks wait only for a stronger lock (DDL, VACUUM FULL), a
-- grant on a table the block does not lock waits only for another update of
-- that table's pg_class row, and the journal insert only for another
-- migrator. The line below gives each of those up after 100 ms, a tenth of
-- PostgreSQL's default deadlock_timeout.
SET LOCAL lock_timeout = '100ms';--> statement-breakpoint
-- §2.2, D3. Roles are cluster-wide, so a second database on the same server
-- meets them already made. A CREATEROLE non-superuser (production's migrating
-- role) may create both, but may not name NOSUPERUSER or NOREPLICATION in an
-- ALTER ROLE (track-i2.md, I.2.2 P12), so a role that already exists is
-- checked below rather than altered.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'requestport_application') THEN
		CREATE ROLE requestport_application NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'requestport_definer') THEN
		CREATE ROLE requestport_definer NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles r
		WHERE r.rolname IN ('requestport_application', 'requestport_definer')
			AND (r.rolsuper OR r.rolcanlogin OR r.rolcreatedb OR r.rolcreaterole
				OR r.rolreplication OR r.rolbypassrls <> (r.rolname = 'requestport_definer'))
	) THEN
		RAISE EXCEPTION 'requestport: requestport_application or requestport_definer exists with attributes row-level security cannot rely on'
			USING ERRCODE = '55000';
	END IF;
	IF EXISTS (
		SELECT 1 FROM pg_catalog.pg_auth_members m
		JOIN pg_catalog.pg_roles r ON r.oid = m.member
		WHERE r.rolname IN ('requestport_application', 'requestport_definer')
	) THEN
		RAISE EXCEPTION 'requestport: requestport_application or requestport_definer is a member of another role'
			USING ERRCODE = '55000';
	END IF;
END $$;--> statement-breakpoint
-- ALTER ... OWNER TO the definer needs SET on it, and INHERIT lets later
-- migrations grant, revoke and replace its functions without SET ROLE (P3).
GRANT requestport_definer TO CURRENT_USER WITH SET TRUE, INHERIT TRUE;--> statement-breakpoint
-- §2.5.0 item 3, D4: the functions' own schema, which no application or
-- worker role may create in, and USAGE granted explicitly, because a local
-- reset recreates public with no grant to PUBLIC (P9).
CREATE SCHEMA IF NOT EXISTS requestport_private;--> statement-breakpoint
REVOKE ALL ON SCHEMA requestport_private FROM PUBLIC;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM PUBLIC;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO requestport_application, requestport_definer;--> statement-breakpoint
GRANT USAGE ON SCHEMA requestport_private TO requestport_application, requestport_definer;--> statement-breakpoint
-- §2.3, D1: what every tenant policy reads. Unbound is an error, never an
-- empty answer: after a transaction-local set_config ends, the same connection
-- reads '' rather than NULL (P1), so '' is unbound too.
CREATE OR REPLACE FUNCTION requestport_private.bound_organization_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
	bound text := nullif(pg_catalog.current_setting('requestport.organization_id', true), '');
BEGIN
	IF bound IS NULL THEN
		RAISE EXCEPTION 'requestport: no organisation is bound to this transaction'
			USING ERRCODE = '42501';
	END IF;
	RETURN bound::uuid;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION requestport_private.bound_user_id()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
	bound text := nullif(pg_catalog.current_setting('requestport.user_id', true), '');
BEGIN
	IF bound IS NULL THEN
		RAISE EXCEPTION 'requestport: no user is bound to this transaction'
			USING ERRCODE = '42501';
	END IF;
	RETURN bound;
END;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.bound_organization_id() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.bound_user_id() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.bound_organization_id() TO requestport_application;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.bound_user_id() TO requestport_application;--> statement-breakpoint
-- For agentAuthRepository.resolveOAuthGrant, which step 2 moves here: the
-- same joins and predicates; expires_at is not returned (no caller reads it).
CREATE OR REPLACE FUNCTION requestport_private.resolve_oauth_grant(p_user_id text, p_client_id text, p_audience text)
RETURNS TABLE (authorization_id uuid, organization_id uuid, agent_principal_id uuid, delegated_by_user_id text, audience text, project_id uuid, lane_ids jsonb, scopes jsonb, refresh_family_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
	SELECT g.id, g.organization_id, g.agent_principal_id, g.user_id, g.audience,
		g.project_id, g.lane_ids, g.scopes, g.refresh_family_id
	FROM public.agent_oauth_grants g
	JOIN public.agent_principals ap
		ON ap.organization_id = g.organization_id
		AND ap.id = g.agent_principal_id
		AND ap.status = 'active'
		AND (ap.project_id IS NULL OR ap.project_id = g.project_id)
	JOIN public.oauth_client c
		ON c.client_id = g.oauth_client_id
		AND c.disabled = false
	JOIN public.organizations o
		ON o.id = g.organization_id
		AND o.status = 'active'
	JOIN public.organization_members om
		ON om.organization_id = g.organization_id
		AND om.user_id = g.user_id
		AND om.status = 'active'
	LEFT JOIN public.project_members pm
		ON pm.organization_id = g.organization_id
		AND pm.project_id = g.project_id
		AND pm.user_id = g.user_id
		AND pm.status = 'active'
	LEFT JOIN public.projects p
		ON p.organization_id = g.organization_id
		AND p.id = g.project_id
		AND p.status = 'active'
	WHERE (g.project_id IS NULL OR p.id IS NOT NULL)
		AND g.user_id = p_user_id
		AND g.oauth_client_id = p_client_id
		AND g.audience = CASE p_audience WHEN 'mcp' THEN 'mcp' WHEN 'api' THEN 'api' END
		AND g.status = 'active'
		AND g.revoked_at IS NULL
		AND g.expires_at > clock_timestamp()
		AND (om.role IN ('owner', 'admin') OR pm.role = 'maintainer')
	LIMIT 1;
$$;--> statement-breakpoint
-- For agentAuthRepository.listOAuthGrantBindingFingerprints: newest first, and
-- one row past the claim's cap of 100 so the caller can report truncation.
-- The cap is a constant here, never an argument (§2.5.0 item 5).
CREATE OR REPLACE FUNCTION requestport_private.list_oauth_grant_binding_fingerprints(p_user_id text, p_audience text)
RETURNS TABLE (client_id text, refresh_family_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
	SELECT g.oauth_client_id, g.refresh_family_id
	FROM public.agent_oauth_grants g
	JOIN public.agent_principals ap
		ON ap.organization_id = g.organization_id
		AND ap.id = g.agent_principal_id
		AND ap.status = 'active'
		AND (ap.project_id IS NULL OR ap.project_id = g.project_id)
	JOIN public.oauth_client c
		ON c.client_id = g.oauth_client_id
		AND c.disabled = false
	JOIN public.organizations o
		ON o.id = g.organization_id
		AND o.status = 'active'
	JOIN public.organization_members om
		ON om.organization_id = g.organization_id
		AND om.user_id = g.user_id
		AND om.status = 'active'
	LEFT JOIN public.project_members pm
		ON pm.organization_id = g.organization_id
		AND pm.project_id = g.project_id
		AND pm.user_id = g.user_id
		AND pm.status = 'active'
	LEFT JOIN public.projects p
		ON p.organization_id = g.organization_id
		AND p.id = g.project_id
		AND p.status = 'active'
	WHERE (g.project_id IS NULL OR p.id IS NOT NULL)
		AND g.user_id = p_user_id
		AND g.audience = CASE p_audience WHEN 'mcp' THEN 'mcp' WHEN 'api' THEN 'api' END
		AND g.status = 'active'
		AND g.revoked_at IS NULL
		AND g.expires_at > clock_timestamp()
		AND (om.role IN ('owner', 'admin') OR pm.role = 'maintainer')
	ORDER BY g.created_at DESC, g.id DESC
	LIMIT 101;
$$;--> statement-breakpoint
-- For the unscoped read in invalidateUnboundOAuthProviderAuthorization: exactly
-- today's predicate, which checks less than resolve_oauth_grant does; the gap
-- is recorded in manifest-i2.md §2.5.0, not changed here.
CREATE OR REPLACE FUNCTION requestport_private.has_usable_oauth_grant(p_user_id text, p_client_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
	SELECT EXISTS (
		SELECT 1
		FROM public.agent_oauth_grants g
		WHERE g.user_id = p_user_id
			AND g.oauth_client_id = p_client_id
			AND g.status = 'active'
		AND g.revoked_at IS NULL
		AND g.expires_at > clock_timestamp()
	);
$$;--> statement-breakpoint
-- For the cross-organisation revocation in bindOAuthConsent. It writes, so its
-- caller must hold a transaction (§2.5.0 item 7). It returns nothing.
CREATE OR REPLACE FUNCTION requestport_private.revoke_user_client_oauth_grants(p_user_id text, p_client_id text)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
	UPDATE public.agent_oauth_grants AS g
	SET status = 'revoked',
		revoked_at = clock_timestamp(),
		updated_at = clock_timestamp(),
		version = g.version + 1
	WHERE g.user_id = p_user_id
		AND g.oauth_client_id = p_client_id
		AND g.status = 'active'
		AND g.revoked_at IS NULL;
$$;--> statement-breakpoint
-- For agentAuthRepository.resolveApiKeyCredential: the same joins and predicates.
-- A credential a grant minted resolves only while that grant, in the same
-- organisation, is still usable.
CREATE OR REPLACE FUNCTION requestport_private.resolve_api_key_credential(p_api_key_id text, p_audience text)
RETURNS TABLE (authorization_id uuid, organization_id uuid, agent_principal_id uuid, audience text, project_id uuid, lane_ids jsonb, scopes jsonb, credential_fingerprint text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
	SELECT cr.id, cr.organization_id, cr.agent_principal_id, cr.audience,
		cr.project_id, cr.lane_ids, cr.scopes, cr.fingerprint
	FROM public.agent_credentials cr
	JOIN public.apikey k
		ON k.id = cr.better_auth_api_key_id
		AND k.enabled = true
		AND k.expires_at > clock_timestamp()
	JOIN public.agent_principals ap
		ON ap.organization_id = cr.organization_id
		AND ap.id = cr.agent_principal_id
		AND ap.status = 'active'
		AND (ap.project_id IS NULL OR ap.project_id = cr.project_id)
	JOIN public.organizations o
		ON o.id = cr.organization_id
		AND o.status = 'active'
	JOIN public.projects p
		ON p.organization_id = cr.organization_id
		AND p.id = cr.project_id
		AND p.status = 'active'
	JOIN public.organization_members om
		ON om.organization_id = cr.organization_id
		AND om.user_id = cr.created_by_user_id
		AND om.status = 'active'
	LEFT JOIN public.project_members pm
		ON pm.organization_id = cr.organization_id
		AND pm.project_id = cr.project_id
		AND pm.user_id = cr.created_by_user_id
		AND pm.status = 'active'
	LEFT JOIN public.agent_oauth_grants g
		ON g.id = cr.issued_by_grant_id
		AND g.organization_id = cr.organization_id
		AND g.status = 'active'
		AND g.revoked_at IS NULL
		AND g.expires_at > clock_timestamp()
	WHERE cr.better_auth_api_key_id = p_api_key_id
		AND cr.audience = CASE p_audience WHEN 'mcp' THEN 'mcp' WHEN 'api' THEN 'api' END
		AND cr.revoked_at IS NULL
		AND cr.expires_at > clock_timestamp()
		AND (cr.issued_by_grant_id IS NULL OR g.id IS NOT NULL)
		AND (om.role IN ('owner', 'admin') OR pm.role = 'maintainer')
	LIMIT 1;
$$;--> statement-breakpoint
-- For operatorCredentialRepository.resolveApiKeyCredential (F.3, F3-15), which
-- step 2 moves here: the same joins and predicates. The plugin row may only
-- narrow: enabled, unexpired and in the operator configuration, whose id is
-- operatorApiKeyConfigId in @requestport/domain. expires_at is not returned
-- (no caller reads it).
CREATE OR REPLACE FUNCTION requestport_private.resolve_operator_credential(p_api_key_id text)
RETURNS TABLE (credential_id uuid, lineage_id uuid, organization_id uuid, member_user_id text, project_id uuid, scopes jsonb, credential_fingerprint text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
	SELECT oc.id, oc.lineage_id, oc.organization_id, oc.member_user_id,
		oc.project_id, oc.scopes, oc.fingerprint
	FROM public.operator_credentials oc
	JOIN public.apikey k
		ON k.id = oc.better_auth_api_key_id
		AND k.config_id = 'requestport-operator'
		AND k.enabled = true
		AND k.expires_at > clock_timestamp()
	JOIN public.organizations o
		ON o.id = oc.organization_id
		AND o.status = 'active'
	JOIN public.organization_members om
		ON om.organization_id = oc.organization_id
		AND om.user_id = oc.member_user_id
		AND om.status = 'active'
	LEFT JOIN public.projects p
		ON p.organization_id = oc.organization_id
		AND p.id = oc.project_id
		AND p.status = 'active'
	LEFT JOIN public.project_members pm
		ON pm.organization_id = oc.organization_id
		AND pm.project_id = oc.project_id
		AND pm.user_id = oc.member_user_id
		AND pm.status = 'active'
	WHERE oc.better_auth_api_key_id = p_api_key_id
		AND oc.revoked_at IS NULL
		AND oc.expires_at > clock_timestamp()
		AND (
			(oc.project_id IS NULL AND om.role IN ('owner', 'admin'))
			OR (p.id IS NOT NULL AND (om.role IN ('owner', 'admin') OR pm.role = 'maintainer'))
		)
	LIMIT 1;
$$;--> statement-breakpoint
-- For slackRepository.consumeOauthState: lock the live state, consume it, and
-- return what the caller binds to. The caller must then check, under that
-- binding, that the user is still a manager, and throw if not, which rolls
-- the consumption back (manifest-i2.md §2.5.0, D11).
CREATE OR REPLACE FUNCTION requestport_private.consume_slack_oauth_state(p_state_hash text)
RETURNS TABLE (organization_id uuid, user_id text, redirect_uri text)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
	WITH live AS (
		SELECT s.id
		FROM public.slack_oauth_states s
		WHERE s.state_hash = p_state_hash
			AND s.consumed_at IS NULL
			AND s.expires_at > clock_timestamp()
		LIMIT 1
		FOR UPDATE
	)
	UPDATE public.slack_oauth_states AS s
	SET consumed_at = clock_timestamp()
	FROM live
	WHERE s.id = live.id
	RETURNING s.organization_id, s.user_id, s.redirect_uri;
$$;--> statement-breakpoint
-- For slackRepository.lockActionToken: the same six-table join, every row locked
-- FOR UPDATE as today's lock without OF does. The token type is a static
-- branch; any other value matches nothing.
CREATE OR REPLACE FUNCTION requestport_private.lock_slack_action_token(p_token_hash text, p_token_type text, p_workspace_id text, p_slack_user_id text)
RETURNS TABLE (token_id uuid, organization_id uuid, question_id uuid, installation_id uuid, action_payload jsonb, answer_id uuid, consumed_at timestamptz, consumed_by_user_id text, slack_user_id text, user_id text, question_version integer)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
	SELECT t.id, t.organization_id, t.question_id, t.installation_id,
		t.action_payload, t.answer_id, t.consumed_at, t.consumed_by_user_id,
		t.slack_user_id, um.user_id, q.version
	FROM public.slack_action_tokens t
	JOIN public.slack_installations i
		ON i.id = t.installation_id
		AND i.workspace_id = p_workspace_id
		AND i.status = 'active'
	JOIN public.slack_user_mappings um
		ON um.installation_id = i.id
		AND um.slack_user_id = p_slack_user_id
		AND um.status = 'active'
	JOIN public.organization_members om
		ON om.organization_id = t.organization_id
		AND om.user_id = um.user_id
		AND om.status = 'active'
	JOIN public.organizations o
		ON o.id = t.organization_id
		AND o.status = 'active'
	JOIN public.questions q
		ON q.id = t.question_id
		AND q.organization_id = t.organization_id
	WHERE t.token_hash = p_token_hash
		AND t.token_type = CASE p_token_type
			WHEN 'answer' THEN 'answer'
			WHEN 'modal_launch' THEN 'modal_launch'
			WHEN 'modal_submit' THEN 'modal_submit'
		END
		AND (t.slack_user_id IS NULL OR t.slack_user_id = p_slack_user_id)
		AND t.expires_at > clock_timestamp()
	LIMIT 1
	FOR UPDATE;
$$;--> statement-breakpoint
-- For notificationRepository.recordProviderCallback. It answers 'processed',
-- 'duplicate' or 'conflict', and never whether a delivery matched. The ranks
-- are notification-repository.ts's providerStatusRank; an unknown status
-- updates nothing, and a delivery's unknown status ranks as 0.
CREATE OR REPLACE FUNCTION requestport_private.record_provider_callback(p_provider text, p_event_id text, p_raw_body text, p_occurred_at timestamptz, p_provider_message_id text, p_status text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
	body_digest text := encode(sha256(convert_to(p_raw_body, 'UTF8')), 'hex');
	receipt_id uuid;
	existing_digest text;
	delivery_id uuid;
	delivery_status text;
	delivery_event_at timestamptz;
	current_rank integer;
	next_rank integer;
BEGIN
	INSERT INTO public.provider_callback_receipts (provider, provider_event_id, body_sha256)
	VALUES (p_provider, p_event_id, body_digest)
	ON CONFLICT DO NOTHING
	RETURNING id INTO receipt_id;

	IF receipt_id IS NULL THEN
		SELECT r.body_sha256 INTO existing_digest
		FROM public.provider_callback_receipts r
		WHERE r.provider = p_provider
			AND r.provider_event_id = p_event_id
		LIMIT 1;
		IF existing_digest IS NULL OR existing_digest <> body_digest THEN
			RETURN 'conflict';
		END IF;
		RETURN 'duplicate';
	END IF;

	IF p_provider_message_id IS NOT NULL AND p_provider_message_id <> '' THEN
		SELECT d.id, d.status, d.last_provider_event_at
		INTO delivery_id, delivery_status, delivery_event_at
		FROM public.email_deliveries d
		WHERE d.provider_message_id = p_provider_message_id
		LIMIT 1;

		current_rank := CASE COALESCE(delivery_status, 'pending')
			WHEN 'pending' THEN 0
			WHEN 'queued' THEN 1
			WHEN 'scheduled' THEN 1
			WHEN 'sent' THEN 2
			WHEN 'delivered' THEN 3
			WHEN 'opened' THEN 4
			WHEN 'clicked' THEN 5
			WHEN 'delivery_delayed' THEN 2
			WHEN 'failed' THEN 6
			WHEN 'bounced' THEN 6
			WHEN 'complained' THEN 6
			WHEN 'suppressed' THEN 6
			WHEN 'canceled' THEN 6
			ELSE 0
		END;
		next_rank := CASE p_status
			WHEN 'pending' THEN 0
			WHEN 'queued' THEN 1
			WHEN 'scheduled' THEN 1
			WHEN 'sent' THEN 2
			WHEN 'delivered' THEN 3
			WHEN 'opened' THEN 4
			WHEN 'clicked' THEN 5
			WHEN 'delivery_delayed' THEN 2
			WHEN 'failed' THEN 6
			WHEN 'bounced' THEN 6
			WHEN 'complained' THEN 6
			WHEN 'suppressed' THEN 6
			WHEN 'canceled' THEN 6
		END;

		IF delivery_id IS NOT NULL
			AND next_rank IS NOT NULL
			AND next_rank >= current_rank
			AND p_occurred_at IS NOT NULL
			AND (delivery_event_at IS NULL OR delivery_event_at <= p_occurred_at)
		THEN
			UPDATE public.email_deliveries AS d
			SET status = p_status,
				last_provider_event_at = p_occurred_at,
				updated_at = clock_timestamp()
			WHERE d.id = delivery_id;
		END IF;
	END IF;

	UPDATE public.provider_callback_receipts AS r
	SET processed_at = clock_timestamp(), outcome = 'processed'
	WHERE r.id = receipt_id;
	RETURN 'processed';
END;
$$;--> statement-breakpoint
-- For signupEligibilityRepository.findInvitations: every invitation for the
-- address, in any organisation, and no organisation id.
CREATE OR REPLACE FUNCTION requestport_private.invitation_eligibility(p_normalized_email text)
RETURNS TABLE (invitation_id uuid, accepted_at timestamptz, revoked_at timestamptz, expires_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
	SELECT i.id, i.accepted_at, i.revoked_at, i.expires_at
	FROM public.invitations i
	WHERE lower(i.normalized_email) = p_normalized_email;
$$;--> statement-breakpoint
-- For signupEligibilityRepository.findAllowlistEntries (D13).
CREATE OR REPLACE FUNCTION requestport_private.signup_allowlist_eligibility(p_normalized_email text)
RETURNS TABLE (status text, expires_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
	SELECT a.status, a.expires_at
	FROM public.signup_allowlist a
	WHERE lower(a.normalized_email) = p_normalized_email;
$$;--> statement-breakpoint
-- §2.5.1: the one cross-organisation listing, in user mode only. Its user is
-- the transaction's binding; it refuses inside an organisation-bound
-- transaction and when no user is bound.
CREATE OR REPLACE FUNCTION requestport_private.active_memberships()
RETURNS TABLE (organization_id uuid, organization_name text, organization_slug text, role text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
	bound_user text := nullif(pg_catalog.current_setting('requestport.user_id', true), '');
BEGIN
	IF nullif(pg_catalog.current_setting('requestport.organization_id', true), '') IS NOT NULL THEN
		RAISE EXCEPTION 'requestport: active_memberships() is refused inside an organisation-bound transaction'
			USING ERRCODE = '42501';
	END IF;
	IF bound_user IS NULL THEN
		RAISE EXCEPTION 'requestport: active_memberships() needs a bound user'
			USING ERRCODE = '42501';
	END IF;
	RETURN QUERY
	SELECT o.id, o.name, o.slug, m.role
	FROM public.organization_members m
	JOIN public.organizations o ON o.id = m.organization_id
	WHERE m.user_id = bound_user
		AND m.status = 'active'
		AND o.status = 'active'
	ORDER BY o.slug, o.id;
END;
$$;--> statement-breakpoint
-- §2.7: 0005's body, unchanged but for SECURITY DEFINER and the pinned path.
-- It already names every table with its schema and compares lowered text.
CREATE OR REPLACE FUNCTION public.requestport_guard_user_signup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
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
$$;--> statement-breakpoint
-- §2.7: 0014's body, unchanged but for SECURITY DEFINER and the pinned path.
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
-- §2.7: 0010's body, with import_runs now named with its schema. As the
-- definer it sees every run, so it can no longer fail open on a run the
-- caller's policy hides.
CREATE OR REPLACE FUNCTION public.requestport_guard_frozen_import_entry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM public.import_runs
		WHERE id = OLD.import_run_id
		AND state IN ('approved', 'applying', 'applied')
	) THEN
		RAISE EXCEPTION 'approved import manifest entries are immutable' USING ERRCODE = '55000';
	END IF;
	RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.resolve_oauth_grant(text, text, text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.list_oauth_grant_binding_fingerprints(text, text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.has_usable_oauth_grant(text, text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.revoke_user_client_oauth_grants(text, text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.resolve_api_key_credential(text, text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.resolve_operator_credential(text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.consume_slack_oauth_state(text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.lock_slack_action_token(text, text, text, text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.record_provider_callback(text, text, text, timestamptz, text, text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.invitation_eligibility(text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.signup_allowlist_eligibility(text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.active_memberships() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.requestport_guard_user_signup() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.requestport_initialize_organization_appearance() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.requestport_guard_frozen_import_entry() FROM PUBLIC;--> statement-breakpoint
-- The new owner needs CREATE on each function's schema while ownership
-- moves, and nothing afterwards (P3 A, D).
GRANT CREATE ON SCHEMA requestport_private, public TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.resolve_oauth_grant(text, text, text) OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.list_oauth_grant_binding_fingerprints(text, text) OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.has_usable_oauth_grant(text, text) OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.revoke_user_client_oauth_grants(text, text) OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.resolve_api_key_credential(text, text) OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.resolve_operator_credential(text) OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.consume_slack_oauth_state(text) OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.lock_slack_action_token(text, text, text, text) OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.record_provider_callback(text, text, text, timestamptz, text, text) OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.invitation_eligibility(text) OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.signup_allowlist_eligibility(text) OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.active_memberships() OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION public.requestport_guard_user_signup() OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION public.requestport_initialize_organization_appearance() OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION public.requestport_guard_frozen_import_entry() OWNER TO requestport_definer;--> statement-breakpoint
REVOKE CREATE ON SCHEMA requestport_private, public FROM requestport_definer;--> statement-breakpoint
-- After ownership moved, never before: while the migrating role owned a
-- function, a grant to itself merged into the owner's own entry, and that
-- entry became the definer's when ownership moved, leaving the migrating role
-- no EXECUTE (track-i2.md, I.2.2). Step 2's code calls these as that role until
-- the switch (§2.2), and step 5 decides whether to revoke it.
GRANT EXECUTE ON FUNCTION requestport_private.resolve_oauth_grant(text, text, text) TO requestport_application, CURRENT_USER;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.list_oauth_grant_binding_fingerprints(text, text) TO requestport_application, CURRENT_USER;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.has_usable_oauth_grant(text, text) TO requestport_application, CURRENT_USER;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.revoke_user_client_oauth_grants(text, text) TO requestport_application, CURRENT_USER;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.resolve_api_key_credential(text, text) TO requestport_application, CURRENT_USER;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.resolve_operator_credential(text) TO requestport_application, CURRENT_USER;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.consume_slack_oauth_state(text) TO requestport_application, CURRENT_USER;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.lock_slack_action_token(text, text, text, text) TO requestport_application, CURRENT_USER;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.record_provider_callback(text, text, text, timestamptz, text, text) TO requestport_application, CURRENT_USER;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.invitation_eligibility(text) TO requestport_application, CURRENT_USER;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.signup_allowlist_eligibility(text) TO requestport_application, CURRENT_USER;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.active_memberships() TO requestport_application, CURRENT_USER;--> statement-breakpoint
-- The last chunk, and one statement: every lock on a table, and then every
-- grant on one, is taken inside this one DO block (see the header).
DO $$
DECLARE
	gives_up_at timestamptz := pg_catalog.clock_timestamp() + interval '20 seconds';
BEGIN
	-- Every table the block alters or a policy reads, locked in one statement
	-- before anything else, NOWAIT. A try that finds any of them held fails at
	-- once; its subtransaction is rolled back, releasing whatever it took, and
	-- the next try comes after a pause of 10-100 ms. So this transaction never
	-- waits for a table lock: no request queues behind a waiting ACCESS
	-- EXCLUSIVE, and none can close a deadlock cycle with it, whatever order
	-- the request takes its own locks in (track-i2.md §13). After 20 seconds
	-- without a free moment it gives up with 55P03 and rolls back whole.
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
				public."slack_delivery_operations", public."webhook_attempts",
				public."user_appearance_preferences", public."command_receipts"
				IN ACCESS EXCLUSIVE MODE NOWAIT;
			EXIT;
		EXCEPTION WHEN lock_not_available THEN
			IF pg_catalog.clock_timestamp() >= gives_up_at THEN
				RAISE EXCEPTION 'requestport: 0019 could not lock its 61 tables at once in 20 seconds of tries; nothing was applied, and it can be run again'
					USING ERRCODE = '55P03';
			END IF;
			PERFORM pg_catalog.pg_sleep(0.01 + pg_catalog.random() * 0.09);
		END;
	END LOOP;
	-- §2.1: one permissive policy per tenant table, applying to PUBLIC, and
	-- nothing else that could widen it. The table owner and BYPASSRLS roles —
	-- production's connection until the switch — are not subject to them.
	ALTER TABLE public."organizations" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."organizations" USING (id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."agent_credentials" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."agent_credentials" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."agent_installations" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."agent_installations" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."agent_oauth_grants" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."agent_oauth_grants" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."agent_principals" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."agent_principals" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."answers" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."answers" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."artifacts" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."artifacts" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."completion_reports" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."completion_reports" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."domain_events" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."domain_events" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."email_deliveries" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."email_deliveries" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."import_apply_reports" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."import_apply_reports" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."import_conflicts" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."import_conflicts" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."import_entry_applications" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."import_entry_applications" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."import_manifest_entries" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."import_manifest_entries" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."import_runs" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."import_runs" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."import_sources" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."import_sources" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."import_task_dispatches" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."import_task_dispatches" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."invitations" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."invitations" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."lanes" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."lanes" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."legacy_aliases" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."legacy_aliases" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."legacy_mappings" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."legacy_mappings" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."machine_workspaces" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."machine_workspaces" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."message_mentions" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."message_mentions" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."messages" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."messages" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."notification_intents" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."notification_intents" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."operator_credentials" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."operator_credentials" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."organization_appearance_defaults" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."organization_appearance_defaults" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."organization_members" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."organization_members" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."project_aliases" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."project_aliases" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."project_members" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."project_members" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."project_repositories" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."project_repositories" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."project_sequences" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."project_sequences" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."projects" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."projects" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."questions" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."questions" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."request_relationships" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."request_relationships" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."requests" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."requests" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."retention_holds" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."retention_holds" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."retention_tombstones" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."retention_tombstones" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."routing_rules" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."routing_rules" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."security_audit_records" ENABLE ROW LEVEL SECURITY;
	-- D12: the session-only user bus writes one audit row with no organisation,
	-- so in user mode a row is admitted only as that user's own.
	CREATE POLICY requestport_tenant ON public."security_audit_records"
		USING (organization_id = (SELECT requestport_private.bound_organization_id()))
		WITH CHECK (
			CASE
				WHEN nullif(pg_catalog.current_setting('requestport.organization_id', true), '') IS NOT NULL
					THEN organization_id = nullif(pg_catalog.current_setting('requestport.organization_id', true), '')::uuid
				ELSE organization_id IS NULL
					AND actor_type = 'user'
					AND actor_id = nullif(pg_catalog.current_setting('requestport.user_id', true), '')
			END
		);
	ALTER TABLE public."slack_action_tokens" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."slack_action_tokens" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."slack_deliveries" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."slack_deliveries" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."slack_installations" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."slack_installations" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."slack_oauth_states" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."slack_oauth_states" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."slack_routes" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."slack_routes" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."slack_user_mappings" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."slack_user_mappings" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."source_artifacts" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."source_artifacts" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."source_snapshots" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."source_snapshots" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."state_transitions" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."state_transitions" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."user_request_read_states" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."user_request_read_states" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."webhook_deliveries" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."webhook_deliveries" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."webhook_subscriptions" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."webhook_subscriptions" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."work_sessions" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."work_sessions" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."work_updates" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."work_updates" USING (organization_id = (SELECT requestport_private.bound_organization_id())) WITH CHECK (organization_id = (SELECT requestport_private.bound_organization_id()));
	ALTER TABLE public."outbox" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."outbox" USING (EXISTS (SELECT 1 FROM public.domain_events parent WHERE parent.id = outbox.event_id)) WITH CHECK (EXISTS (SELECT 1 FROM public.domain_events parent WHERE parent.id = outbox.event_id));
	ALTER TABLE public."request_acceptance_criteria" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."request_acceptance_criteria" USING (EXISTS (SELECT 1 FROM public.requests parent WHERE parent.id = request_acceptance_criteria.request_id)) WITH CHECK (EXISTS (SELECT 1 FROM public.requests parent WHERE parent.id = request_acceptance_criteria.request_id));
	ALTER TABLE public."request_labels" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."request_labels" USING (EXISTS (SELECT 1 FROM public.requests parent WHERE parent.id = request_labels.request_id)) WITH CHECK (EXISTS (SELECT 1 FROM public.requests parent WHERE parent.id = request_labels.request_id));
	ALTER TABLE public."slack_delivery_operations" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."slack_delivery_operations" USING (EXISTS (SELECT 1 FROM public.slack_installations parent WHERE parent.id = slack_delivery_operations.installation_id)) WITH CHECK (EXISTS (SELECT 1 FROM public.slack_installations parent WHERE parent.id = slack_delivery_operations.installation_id));
	ALTER TABLE public."webhook_attempts" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_tenant ON public."webhook_attempts" USING (EXISTS (SELECT 1 FROM public.webhook_deliveries parent WHERE parent.id = webhook_attempts.delivery_id)) WITH CHECK (EXISTS (SELECT 1 FROM public.webhook_deliveries parent WHERE parent.id = webhook_attempts.delivery_id));
	-- D1: global by design, one row per user, and read only with a user bound.
	ALTER TABLE public."user_appearance_preferences" ENABLE ROW LEVEL SECURITY;
	CREATE POLICY requestport_user ON public."user_appearance_preferences" USING (user_id = (SELECT requestport_private.bound_user_id())) WITH CHECK (user_id = (SELECT requestport_private.bound_user_id()));
	-- Nullable with no default: a catalogue change, no rewrite. The lock was
	-- taken with the others at the top of this block.
	ALTER TABLE public."command_receipts" ADD COLUMN "organization_id" uuid;
	-- Every grant on a table comes after the locks (see the header): by here
	-- this transaction holds ACCESS EXCLUSIVE on each table it locked, so no
	-- VACUUM or ANALYZE can be part-way through one, and it takes no lock on
	-- the sixteen granted tables it never locks.
	-- D3: the definer holds only the table privileges its bodies use. A row
	-- lock needs UPDATE on at least one column (P10); where a body only locks,
	-- that is UPDATE (id).
	GRANT SELECT ON public.agent_principals, public.oauth_client, public.project_members,
		public.projects, public.agent_credentials, public.apikey, public.import_runs,
		public.operator_credentials TO requestport_definer;
	GRANT SELECT, UPDATE (status, revoked_at, updated_at, version) ON public.agent_oauth_grants TO requestport_definer;
	GRANT SELECT, UPDATE (id) ON public.organizations, public.slack_action_tokens,
		public.slack_installations, public.slack_user_mappings, public.questions,
		public.signup_allowlist TO requestport_definer;
	GRANT SELECT, INSERT, UPDATE (role, status, joined_at, updated_at) ON public.organization_members TO requestport_definer;
	GRANT SELECT, UPDATE (accepted_at) ON public.invitations TO requestport_definer;
	GRANT SELECT, UPDATE (consumed_at) ON public.slack_oauth_states TO requestport_definer;
	GRANT SELECT, INSERT, UPDATE (processed_at, outcome) ON public.provider_callback_receipts TO requestport_definer;
	GRANT SELECT, UPDATE (status, last_provider_event_at, updated_at) ON public.email_deliveries TO requestport_definer;
	GRANT SELECT, INSERT ON public.organization_appearance_defaults TO requestport_definer;
	GRANT INSERT ON public.domain_events, public.outbox TO requestport_definer;
	-- §2.10: the application group's grants, from every query site it reaches.
	-- TRUNCATE, REFERENCES and TRIGGER go to nobody; public holds no sequence.
	GRANT SELECT, INSERT, UPDATE, DELETE ON public."account" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."agent_credentials" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE (id) ON public."agent_installations" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."agent_oauth_grants" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."agent_principals" TO requestport_application;
	GRANT SELECT, INSERT ON public."answers" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE, DELETE ON public."apikey" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE (id) ON public."artifacts" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE, DELETE ON public."command_receipts" TO requestport_application;
	GRANT SELECT, INSERT ON public."completion_reports" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE (id) ON public."domain_events" TO requestport_application;
	GRANT SELECT, UPDATE ON public."email_deliveries" TO requestport_application;
	GRANT SELECT ON public."import_apply_reports" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."import_conflicts" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."import_manifest_entries" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."import_runs" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE (id) ON public."import_sources" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."import_task_dispatches" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."invitations" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE, DELETE ON public."jwks" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."lanes" TO requestport_application;
	GRANT SELECT ON public."legacy_aliases" TO requestport_application;
	GRANT SELECT ON public."legacy_mappings" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE (id) ON public."machine_workspaces" TO requestport_application;
	GRANT SELECT, INSERT ON public."message_mentions" TO requestport_application;
	GRANT SELECT, INSERT ON public."messages" TO requestport_application;
	GRANT SELECT, UPDATE ON public."notification_intents" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE, DELETE ON public."oauth_access_token" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE, DELETE ON public."oauth_client" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE, DELETE ON public."oauth_client_assertion" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE, DELETE ON public."oauth_client_resource" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE, DELETE ON public."oauth_consent" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE, DELETE ON public."oauth_refresh_token" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE, DELETE ON public."oauth_resource" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."operator_credentials" TO requestport_application;
	GRANT SELECT, UPDATE ON public."organization_appearance_defaults" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."organization_members" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE (id) ON public."organizations" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."outbox" TO requestport_application;
	GRANT SELECT, INSERT ON public."project_aliases" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."project_members" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."project_repositories" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."project_sequences" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."projects" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."provider_callback_receipts" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."questions" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."rate_limit_buckets" TO requestport_application;
	GRANT SELECT, INSERT ON public."request_acceptance_criteria" TO requestport_application;
	GRANT SELECT, INSERT ON public."request_labels" TO requestport_application;
	GRANT SELECT, INSERT, DELETE ON public."request_relationships" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."requests" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."retention_holds" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."routing_rules" TO requestport_application;
	GRANT INSERT ON public."security_audit_records" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE, DELETE ON public."session" TO requestport_application;
	GRANT SELECT ON public."signup_allowlist" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."slack_action_tokens" TO requestport_application;
	GRANT SELECT ON public."slack_deliveries" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."slack_delivery_operations" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."slack_installations" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."slack_oauth_states" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."slack_routes" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."slack_user_mappings" TO requestport_application;
	GRANT SELECT, INSERT ON public."source_artifacts" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."source_snapshots" TO requestport_application;
	GRANT INSERT ON public."state_transitions" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE, DELETE ON public."user" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."user_appearance_preferences" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."user_request_read_states" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE, DELETE ON public."verification" TO requestport_application;
	GRANT SELECT ON public."webhook_attempts" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE (id) ON public."webhook_deliveries" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."webhook_subscriptions" TO requestport_application;
	GRANT SELECT, INSERT, UPDATE ON public."work_sessions" TO requestport_application;
	GRANT SELECT, INSERT ON public."work_updates" TO requestport_application;
END $$;
