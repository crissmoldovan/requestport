-- requestport: this migration must be the last one applied in its transaction
-- Plan 13, Track I.2b, step b1: the worker's group roles, the tenant
-- processor's grants and the seventeen worker functions, as an expand
-- (docs/implementation/plans/2026-09-27-13/manifest-i2.md §5.1, §5.2 b1;
-- track-i2.md, "I.2b design (2026-09-30)" and "b1 built (2026-09-30)").
--
-- Nothing calls any of it in b1: the worker still connects as the owner, and
-- no code names a function created here until b2. Applied to production it
-- adds three NOLOGIN group roles with no members, one table in
-- requestport_private and seventeen functions, and grants: to the three
-- roles, and to requestport_definer the table privileges the new bodies use.
-- It changes no table's columns, rows or policies, and no existing function's
-- body or owner.
--
-- Where the locks are (track-i2.md, "b1 built": the lock probe and the
-- traffic runs). No statement here locks a table that existed before it:
-- GRANT and REVOKE on a table take no table lock, every function is LANGUAGE
-- plpgsql (whose body is not planned, and so locks nothing, when it is
-- created), and the one CREATE TABLE makes a new table in
-- requestport_private. So no request queues behind this migration, and it
-- takes neither 0019's NOWAIT loop nor its lock_timeout, which answer table
-- locks this migration does not take. One wait remains, and no request is in
-- it: a table GRANT rewrites the table's pg_class row, so a VACUUM or ANALYZE
-- of that table that reaches its own update of the row waits for this
-- migration's commit, holding SHARE UPDATE EXCLUSIVE, which blocks DDL on the
-- table but no read or write. A later migration applied in the same
-- transaction that altered one of those tables would wait on that VACUUM
-- while the VACUUM waits on this transaction (0019's §12).
--
-- So the first line marks it, as 0019 is marked (scripts/migration-support.mjs,
-- LAST_IN_TRANSACTION_MARKER): the production launcher refuses to apply it
-- with another migration pending after it, and the gate's migration-state step
-- fails while the journal has an entry after it and
-- production-migration-state.json does not record it as applied.
DO $$
BEGIN
	-- §2.2, D3's pattern (0019): roles are cluster-wide, so a second database
	-- on the same server meets them already made. A CREATEROLE non-superuser
	-- may create them, but may not name NOSUPERUSER or NOREPLICATION in an
	-- ALTER ROLE (track-i2.md, I.2.2 P12), so an existing one is checked below
	-- rather than altered.
	IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'requestport_dispatcher') THEN
		CREATE ROLE requestport_dispatcher NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'requestport_tenant_processor') THEN
		CREATE ROLE requestport_tenant_processor NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'requestport_maintenance') THEN
		CREATE ROLE requestport_maintenance NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles r
		WHERE r.rolname IN ('requestport_dispatcher', 'requestport_tenant_processor', 'requestport_maintenance')
			AND (r.rolsuper OR r.rolcanlogin OR r.rolcreatedb OR r.rolcreaterole
				OR r.rolreplication OR r.rolbypassrls)
	) THEN
		RAISE EXCEPTION 'requestport: a worker group role exists with attributes row-level security cannot rely on'
			USING ERRCODE = '55000';
	END IF;
	IF EXISTS (
		SELECT 1 FROM pg_catalog.pg_auth_members m
		JOIN pg_catalog.pg_roles r ON r.oid = m.member
		WHERE r.rolname IN ('requestport_dispatcher', 'requestport_tenant_processor', 'requestport_maintenance')
	) THEN
		RAISE EXCEPTION 'requestport: a worker group role is a member of another role'
			USING ERRCODE = '55000';
	END IF;
	IF EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles r
		WHERE r.rolname IN ('requestport_dispatcher', 'requestport_tenant_processor', 'requestport_maintenance')
			AND (EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner = r.oid)
				OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner = r.oid)
				OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner = r.oid))
	) THEN
		RAISE EXCEPTION 'requestport: a worker group role owns an object in this database'
			USING ERRCODE = '55000';
	END IF;
END $$;--> statement-breakpoint
-- §5.1: the dispatcher and the maintenance role reach rows only through their
-- functions, so they need the functions' schema and nothing else. The
-- processor also reads public under the tenant policies, and each of those
-- policies calls bound_organization_id() as the querying role (0019).
GRANT USAGE ON SCHEMA requestport_private TO requestport_dispatcher, requestport_tenant_processor, requestport_maintenance;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO requestport_tenant_processor;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.bound_organization_id() TO requestport_tenant_processor;--> statement-breakpoint
-- Function 17's ages (§5.1 (c), ruling 43): a policy the function owns. Only
-- requestport_definer, which runs it, is granted to read it.
-- The ages are today's retentionAgeMs (packages/domain/src/retention/
-- retention-service.ts), in milliseconds, so a daylight-saving change in the
-- session's time zone cannot move a cutoff; a test pins that they are equal.
CREATE TABLE requestport_private.retention_ages (
	category text PRIMARY KEY,
	age_ms bigint NOT NULL CHECK (age_ms >= 0)
);--> statement-breakpoint
INSERT INTO requestport_private.retention_ages (category, age_ms) VALUES
	('verification', 86400000),
	('session', 604800000),
	('oauth_access_token', 604800000),
	('oauth_refresh_token', 2592000000),
	('command_receipt', 0),
	('slack_oauth_state', 86400000),
	('slack_action_token', 604800000),
	('provider_callback_receipt', 7776000000),
	('rate_limit_bucket', 0);--> statement-breakpoint
REVOKE ALL ON TABLE requestport_private.retention_ages FROM PUBLIC;--> statement-breakpoint
-- (a) Dispatcher. 1: outboxRepository.claimBatch's eligibility, order and
-- skip-locked claim, each row leased under an id this body generates.
CREATE OR REPLACE FUNCTION requestport_private.claim_outbox_batch(p_limit integer, p_lease_seconds integer)
RETURNS TABLE (outbox_id uuid, event_id uuid, organization_id uuid, attempt_count integer, lease_id uuid, lease_expires_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
	v_limit integer := LEAST(200, GREATEST(1, COALESCE(p_limit, 50)));
	v_lease_seconds integer := LEAST(600, GREATEST(10, COALESCE(p_lease_seconds, 60)));
BEGIN
	RETURN QUERY
	WITH eligible AS (
		SELECT o.id
		FROM public.outbox o
		WHERE (
			o.state = 'pending'
			OR (o.state = 'leased' AND o.lease_expires_at < clock_timestamp())
			OR (o.state = 'accepted' AND o.updated_at < clock_timestamp() - interval '10 minutes')
		)
			AND o.next_attempt_at <= clock_timestamp()
		ORDER BY o.created_at, o.id
		FOR UPDATE SKIP LOCKED
		LIMIT v_limit
	), claimed AS (
		UPDATE public.outbox o
		SET state = 'leased',
			lease_owner = gen_random_uuid()::text,
			lease_expires_at = clock_timestamp() + v_lease_seconds * interval '1 second',
			attempt_count = o.attempt_count + 1,
			updated_at = clock_timestamp()
		FROM eligible e
		WHERE o.id = e.id
		RETURNING o.id, o.event_id, o.attempt_count, o.lease_owner, o.lease_expires_at
	)
	SELECT c.id, c.event_id, d.organization_id, c.attempt_count, c.lease_owner::uuid, c.lease_expires_at
	FROM claimed c
	JOIN public.domain_events d ON d.id = c.event_id;
END;
$$;--> statement-breakpoint
-- 2: markAccepted on the dispatcher's path, matched on the lease id and an
-- unexpired lease. It records p_run_id as the row's trigger_run_id; the
-- caller passes the id trigger() returned.
CREATE OR REPLACE FUNCTION requestport_private.accept_outbox_claim(p_outbox_id uuid, p_lease_id uuid, p_run_id text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
	IF p_run_id IS NULL OR char_length(p_run_id) < 1 OR char_length(p_run_id) > 255 THEN
		RAISE EXCEPTION 'requestport: a run id is 1 to 255 characters'
			USING ERRCODE = '22023';
	END IF;
	UPDATE public.outbox o
	SET state = 'accepted',
		trigger_run_id = p_run_id,
		accepted_at = clock_timestamp(),
		lease_owner = NULL,
		lease_expires_at = NULL,
		updated_at = clock_timestamp()
	WHERE o.id = p_outbox_id
		AND o.state = 'leased'
		AND o.lease_owner = p_lease_id::text
		AND o.lease_expires_at > clock_timestamp();
	RETURN FOUND;
END;
$$;--> statement-breakpoint
-- 3: the poller's retry and dead letter, matched as 2 is. A null
-- p_dead_letter retries; the delay is clamped as retry() clamps it.
CREATE OR REPLACE FUNCTION requestport_private.release_outbox_claim(p_outbox_id uuid, p_lease_id uuid, p_dead_letter boolean, p_delay_ms integer)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
	v_delay_ms integer := LEAST(3600000, GREATEST(1000, COALESCE(p_delay_ms, 1000)));
BEGIN
	IF COALESCE(p_dead_letter, false) THEN
		UPDATE public.outbox o
		SET state = 'dead_letter',
			lease_owner = NULL,
			lease_expires_at = NULL,
			updated_at = clock_timestamp()
		WHERE o.id = p_outbox_id
			AND o.state = 'leased'
			AND o.lease_owner = p_lease_id::text
			AND o.lease_expires_at > clock_timestamp();
	ELSE
		UPDATE public.outbox o
		SET state = 'pending',
			lease_owner = NULL,
			lease_expires_at = NULL,
			next_attempt_at = clock_timestamp() + v_delay_ms * interval '1 millisecond',
			updated_at = clock_timestamp()
		WHERE o.id = p_outbox_id
			AND o.state = 'leased'
			AND o.lease_owner = p_lease_id::text
			AND o.lease_expires_at > clock_timestamp();
	END IF;
	RETURN FOUND;
END;
$$;--> statement-breakpoint
-- 4: importTaskDispatchRepository.claimBatch: the dead-letter update, then the
-- claim. The attempt ceiling (8) and the accepted-retry window (15 minutes)
-- are constants here, no longer arguments.
CREATE OR REPLACE FUNCTION requestport_private.claim_import_dispatch_batch(p_limit integer, p_lease_seconds integer)
RETURNS TABLE (dispatch_id uuid, organization_id uuid, task_kind text, attempt_count integer, lease_id uuid, lease_expires_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
	v_limit integer := LEAST(200, GREATEST(1, COALESCE(p_limit, 50)));
	v_lease_seconds integer := LEAST(1800, GREATEST(60, COALESCE(p_lease_seconds, 60)));
BEGIN
	UPDATE public.import_task_dispatches t
	SET state = 'dead_letter',
		lease_owner = NULL,
		lease_expires_at = NULL,
		last_error_code = 'dispatch_attempts_exhausted',
		updated_at = clock_timestamp()
	WHERE t.attempt_count >= 8
		AND (
			t.state = 'pending'
			OR (t.state = 'leased' AND t.lease_expires_at < clock_timestamp())
			OR (t.state = 'accepted' AND t.updated_at < clock_timestamp() - interval '15 minutes')
		);
	RETURN QUERY
	WITH eligible AS (
		SELECT t.id
		FROM public.import_task_dispatches t
		WHERE t.attempt_count < 8
			AND (
				t.state = 'pending'
				OR (t.state = 'leased' AND t.lease_expires_at < clock_timestamp())
				OR (t.state = 'accepted' AND t.updated_at < clock_timestamp() - interval '15 minutes')
			)
		ORDER BY t.updated_at, t.id
		FOR UPDATE SKIP LOCKED
		LIMIT v_limit
	), claimed AS (
		UPDATE public.import_task_dispatches t
		SET state = 'leased',
			lease_owner = gen_random_uuid()::text,
			lease_expires_at = clock_timestamp() + v_lease_seconds * interval '1 second',
			attempt_count = t.attempt_count + 1,
			updated_at = clock_timestamp()
		FROM eligible e
		WHERE t.id = e.id
		RETURNING t.id, t.organization_id, t.task_kind, t.attempt_count, t.lease_owner, t.lease_expires_at
	)
	SELECT c.id, c.organization_id, c.task_kind, c.attempt_count, c.lease_owner::uuid, c.lease_expires_at
	FROM claimed c;
END;
$$;--> statement-breakpoint
-- 5: as 2, for a dispatch.
CREATE OR REPLACE FUNCTION requestport_private.accept_import_dispatch_claim(p_dispatch_id uuid, p_lease_id uuid, p_run_id text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
	IF p_run_id IS NULL OR char_length(p_run_id) < 1 OR char_length(p_run_id) > 255 THEN
		RAISE EXCEPTION 'requestport: a run id is 1 to 255 characters'
			USING ERRCODE = '22023';
	END IF;
	UPDATE public.import_task_dispatches t
	SET state = 'accepted',
		trigger_run_id = p_run_id,
		accepted_at = clock_timestamp(),
		last_error_code = NULL,
		lease_owner = NULL,
		lease_expires_at = NULL,
		updated_at = clock_timestamp()
	WHERE t.id = p_dispatch_id
		AND t.state = 'leased'
		AND t.lease_owner = p_lease_id::text
		AND t.lease_expires_at > clock_timestamp();
	RETURN FOUND;
END;
$$;--> statement-breakpoint
-- 6: notificationRepository.dueNotificationIntents, with its attempt ceiling
-- (8) as a constant.
CREATE OR REPLACE FUNCTION requestport_private.due_notification_intents(p_limit integer)
RETURNS TABLE (intent_id uuid, organization_id uuid, channel text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
	RETURN QUERY
	SELECT n.id, n.organization_id, n.channel
	FROM public.notification_intents n
	WHERE n.attempt_count < 8
		AND (
			(n.status IN ('pending', 'failed')
				AND n.next_attempt_at IS NOT NULL
				AND n.next_attempt_at <= clock_timestamp())
			OR (n.status = 'delivering'
				AND (n.lease_expires_at IS NULL OR n.lease_expires_at <= clock_timestamp()))
		)
	ORDER BY n.next_attempt_at, n.created_at
	LIMIT LEAST(500, GREATEST(1, COALESCE(p_limit, 100)));
END;
$$;--> statement-breakpoint
-- 7: outboxRepository.pendingWebhookDeliveries.
CREATE OR REPLACE FUNCTION requestport_private.pending_webhook_deliveries(p_limit integer)
RETURNS TABLE (delivery_id uuid, organization_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
	RETURN QUERY
	SELECT d.id, d.organization_id
	FROM public.webhook_deliveries d
	JOIN public.webhook_subscriptions s
		ON s.id = d.subscription_id
		AND s.organization_id = d.organization_id
		AND s.status = 'active'
	WHERE d.status = 'pending'
		OR (
			d.status = 'retry'
			AND EXISTS (
				SELECT 1
				FROM public.webhook_attempts a
				WHERE a.delivery_id = d.id
					AND a.next_attempt_at <= clock_timestamp()
					AND NOT EXISTS (
						SELECT 1 FROM public.webhook_attempts newer
						WHERE newer.delivery_id = d.id
							AND newer.attempt_number > a.attempt_number
					)
			)
		)
		OR (
			d.status = 'delivering'
			AND EXISTS (
				SELECT 1
				FROM public.webhook_attempts a
				WHERE a.delivery_id = d.id
					AND a.finished_at IS NULL
					AND a.started_at < clock_timestamp() - interval '10 minutes'
					AND NOT EXISTS (
						SELECT 1 FROM public.webhook_attempts newer
						WHERE newer.delivery_id = d.id
							AND newer.attempt_number > a.attempt_number
					)
			)
		)
	ORDER BY d.created_at, d.id
	LIMIT LEAST(500, GREATEST(1, COALESCE(p_limit, 100)));
END;
$$;--> statement-breakpoint
-- 8 and 9: slackRepository.dueSlackDeliveryOperations, one function per type
-- (§5.1: no function takes a kind name).
CREATE OR REPLACE FUNCTION requestport_private.due_slack_message_updates(p_limit integer)
RETURNS TABLE (operation_id uuid, organization_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
	RETURN QUERY
	SELECT op.id, si.organization_id
	FROM public.slack_delivery_operations op
	JOIN public.slack_installations si
		ON si.id = op.installation_id
		AND si.status = 'active'
	WHERE op.operation_type = 'message_update'
		AND (
			(op.status IN ('pending', 'retry') AND op.next_attempt_at <= clock_timestamp())
			OR (op.status = 'delivering' AND op.lease_expires_at < clock_timestamp())
		)
	ORDER BY op.next_attempt_at, op.created_at
	LIMIT LEAST(500, GREATEST(1, COALESCE(p_limit, 100)));
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION requestport_private.due_slack_connection_tests(p_limit integer)
RETURNS TABLE (operation_id uuid, organization_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
	RETURN QUERY
	SELECT op.id, si.organization_id
	FROM public.slack_delivery_operations op
	JOIN public.slack_installations si
		ON si.id = op.installation_id
		AND si.status = 'active'
	WHERE op.operation_type = 'connection_test'
		AND (
			(op.status IN ('pending', 'retry') AND op.next_attempt_at <= clock_timestamp())
			OR (op.status = 'delivering' AND op.lease_expires_at < clock_timestamp())
		)
	ORDER BY op.next_attempt_at, op.created_at
	LIMIT LEAST(500, GREATEST(1, COALESCE(p_limit, 100)));
END;
$$;--> statement-breakpoint
-- 10 and 11: workSweepRepository.listLeaseExpired and listGraceExpired;
-- version is returned because the sweep's idempotency key uses it.
CREATE OR REPLACE FUNCTION requestport_private.lease_expired_work_sessions(p_limit integer)
RETURNS TABLE (session_id uuid, organization_id uuid, version integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
	RETURN QUERY
	SELECT w.id, w.organization_id, w.version
	FROM public.work_sessions w
	WHERE w.state IN ('claimed', 'active', 'paused', 'blocked')
		AND w.lease_expires_at < clock_timestamp()
	ORDER BY w.lease_expires_at, w.id
	LIMIT LEAST(500, GREATEST(1, COALESCE(p_limit, 100)));
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION requestport_private.grace_expired_work_sessions(p_limit integer)
RETURNS TABLE (session_id uuid, organization_id uuid, version integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
	RETURN QUERY
	SELECT w.id, w.organization_id, w.version
	FROM public.work_sessions w
	WHERE w.state = 'stale'
		AND w.grace_expires_at < clock_timestamp()
	ORDER BY w.grace_expires_at, w.id
	LIMIT LEAST(500, GREATEST(1, COALESCE(p_limit, 100)));
END;
$$;--> statement-breakpoint
-- 12: webhookRepository.listDueSecretPromotions, without the ciphertexts,
-- which the body loads bound.
CREATE OR REPLACE FUNCTION requestport_private.due_webhook_secret_promotions(p_limit integer)
RETURNS TABLE (subscription_id uuid, organization_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
	RETURN QUERY
	SELECT s.id, s.organization_id
	FROM public.webhook_subscriptions s
	WHERE s.next_secret_ciphertext IS NOT NULL
		AND s.overlap_ends_at IS NOT NULL
		AND s.overlap_ends_at <= clock_timestamp()
	ORDER BY s.overlap_ends_at
	LIMIT LEAST(500, GREATEST(1, COALESCE(p_limit, 100)));
END;
$$;--> statement-breakpoint
-- 13: the discovery half of materializeDueQuestionReminders. as_of is the
-- database's clock read once here, which the bound half uses as its now.
CREATE OR REPLACE FUNCTION requestport_private.due_question_reminders(p_limit integer)
RETURNS TABLE (question_id uuid, organization_id uuid, as_of timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
	v_as_of timestamptz := clock_timestamp();
BEGIN
	RETURN QUERY
	SELECT q.id, q.organization_id, v_as_of
	FROM public.questions q
	JOIN public.organizations o
		ON o.id = q.organization_id
		AND o.status = 'active'
	JOIN public.requests r
		ON r.id = q.parent_request_id
		AND r.organization_id = q.organization_id
	JOIN public.projects p
		ON p.id = r.target_project_id
		AND p.organization_id = r.organization_id
		AND p.status = 'active'
	WHERE q.state = 'open'
		AND q.deadline_at IS NOT NULL
		-- 168 hours, not '7 days': today's query adds a fixed 7 * 24 * 60 * 60_000 ms
		-- (notification-repository.ts), and a days interval is calendar days in the
		-- caller's session time zone, which a daylight-saving change moves by an hour.
		AND q.deadline_at <= v_as_of + interval '168 hours'
	ORDER BY q.deadline_at, q.id
	LIMIT LEAST(200, GREATEST(1, COALESCE(p_limit, 200)));
END;
$$;--> statement-breakpoint
-- (b) Tenant processor. 14: whose in-flight job an id is, answered only with
-- no organisation bound. In flight is each table's non-terminal states
-- (track-i2.md, "I.2b design": outbox and dispatches leased or accepted;
-- webhook deliveries and Slack operations pending, delivering or retry;
-- notification intents pending, delivering or failed). Absent, finished, an
-- unlisted kind and a kind that does not match the id all answer NULL.
CREATE OR REPLACE FUNCTION requestport_private.resolve_job_organization(p_kind text, p_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
	v_organization_id uuid;
BEGIN
	IF nullif(pg_catalog.current_setting('requestport.organization_id', true), '') IS NOT NULL THEN
		RAISE EXCEPTION 'requestport: a job''s organisation is resolved only before one is bound'
			USING ERRCODE = '42501';
	END IF;
	CASE p_kind
		WHEN 'outbox' THEN
			SELECT d.organization_id INTO v_organization_id
			FROM public.outbox o
			JOIN public.domain_events d ON d.id = o.event_id
			WHERE o.id = p_id AND o.state IN ('leased', 'accepted');
		WHEN 'webhook_delivery' THEN
			SELECT w.organization_id INTO v_organization_id
			FROM public.webhook_deliveries w
			WHERE w.id = p_id AND w.status IN ('pending', 'delivering', 'retry');
		WHEN 'notification_intent' THEN
			SELECT n.organization_id INTO v_organization_id
			FROM public.notification_intents n
			WHERE n.id = p_id AND n.status IN ('pending', 'delivering', 'failed');
		WHEN 'slack_delivery_operation' THEN
			SELECT si.organization_id INTO v_organization_id
			FROM public.slack_delivery_operations op
			JOIN public.slack_installations si ON si.id = op.installation_id
			WHERE op.id = p_id AND op.status IN ('pending', 'delivering', 'retry');
		WHEN 'import_task_dispatch' THEN
			SELECT t.organization_id INTO v_organization_id
			FROM public.import_task_dispatches t
			WHERE t.id = p_id AND t.state IN ('leased', 'accepted');
		ELSE
			v_organization_id := NULL;
	END CASE;
	RETURN v_organization_id;
END;
$$;--> statement-breakpoint
-- (c) Maintenance: fixed bodies, counts only (ruling 34). 15: the operational
-- metrics snapshot's eight counts.
CREATE OR REPLACE FUNCTION requestport_private.operational_metrics_snapshot()
RETURNS TABLE (pending_outbox bigint, oldest_outbox_seconds numeric, dead_letter_webhooks bigint, notification_backlog bigint, stale_sessions bigint, open_import_conflicts bigint, slack_operation_backlog bigint, dead_letter_import_dispatches bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
	RETURN QUERY
	SELECT
		(SELECT count(*) FROM public.outbox o WHERE o.state IN ('pending', 'leased', 'accepted')),
		COALESCE((
			SELECT GREATEST(0, extract(epoch FROM (clock_timestamp() - min(o.created_at))))
			FROM public.outbox o
			WHERE o.state IN ('pending', 'leased', 'accepted')
		), 0),
		(SELECT count(*) FROM public.webhook_deliveries w WHERE w.status = 'dead_letter'),
		(SELECT count(*) FROM public.notification_intents n WHERE n.status IN ('pending', 'delivering', 'failed')),
		(SELECT count(*) FROM public.work_sessions s WHERE s.state = 'stale'),
		(SELECT count(*) FROM public.import_conflicts c WHERE c.severity = 'blocking' AND c.resolved_at IS NULL),
		(SELECT count(*) FROM public.slack_delivery_operations op WHERE op.status IN ('pending', 'delivering', 'retry')),
		(SELECT count(*) FROM public.import_task_dispatches t WHERE t.state = 'dead_letter');
END;
$$;--> statement-breakpoint
-- 16: outboxRepository.pendingBacklog, for Trigger's outbox-repair.
CREATE OR REPLACE FUNCTION requestport_private.outbox_pending_backlog()
RETURNS TABLE (pending_count integer, oldest_age_seconds integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
	RETURN QUERY
	SELECT
		count(*)::integer,
		COALESCE(extract(epoch FROM (clock_timestamp() - min(o.created_at))), 0)::integer
	FROM public.outbox o
	WHERE (
		o.state = 'pending'
		OR (o.state = 'leased' AND o.lease_expires_at < clock_timestamp())
		OR (o.state = 'accepted' AND o.updated_at < clock_timestamp() - interval '10 minutes')
	)
		AND o.next_attempt_at <= clock_timestamp();
END;
$$;--> statement-breakpoint
-- 17: retentionRepository.cleanup for one category. The cutoff is this
-- function's clock less the category's age in retention_ages, never an
-- argument. It selects, tombstones and deletes the rows today's cleanup
-- does: the same candidates, locked and skipped the same way, and a
-- tombstone whose digest is the SHA-256 of the sorted ids as a JSON array,
-- which is what canonicalJson gave for them.
CREATE OR REPLACE FUNCTION requestport_private.retention_cleanup(p_category text, p_batch_size integer)
RETURNS TABLE (category text, deleted integer, tombstone_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
	v_batch_size integer := LEAST(1000, GREATEST(1, COALESCE(p_batch_size, 500)));
	v_age_ms bigint;
	v_cutoff timestamptz;
	v_ids text[];
	v_tombstone_id uuid;
BEGIN
	CASE p_category
		WHEN 'verification', 'session', 'oauth_access_token', 'oauth_refresh_token',
			'command_receipt', 'slack_oauth_state', 'slack_action_token',
			'provider_callback_receipt', 'rate_limit_bucket' THEN
			NULL;
		ELSE
			RAISE EXCEPTION 'requestport: unknown retention category'
				USING ERRCODE = '22023';
	END CASE;
	SELECT a.age_ms INTO STRICT v_age_ms
	FROM requestport_private.retention_ages a
	WHERE a.category = p_category;
	v_cutoff := clock_timestamp() - v_age_ms * interval '1 millisecond';

	CASE p_category
		WHEN 'verification' THEN
			SELECT array_agg(c.id ORDER BY c.id COLLATE "C") INTO v_ids FROM (
				SELECT v.id::text AS id FROM public.verification v
				WHERE v.expires_at < v_cutoff
				ORDER BY v.expires_at, v.id LIMIT v_batch_size FOR UPDATE SKIP LOCKED
			) c;
		WHEN 'session' THEN
			SELECT array_agg(c.id ORDER BY c.id COLLATE "C") INTO v_ids FROM (
				SELECT s.id::text AS id FROM public.session s
				WHERE s.expires_at < v_cutoff
				ORDER BY s.expires_at, s.id LIMIT v_batch_size FOR UPDATE SKIP LOCKED
			) c;
		WHEN 'oauth_access_token' THEN
			SELECT array_agg(c.id ORDER BY c.id COLLATE "C") INTO v_ids FROM (
				SELECT t.id::text AS id FROM public.oauth_access_token t
				WHERE t.expires_at IS NOT NULL AND t.expires_at < v_cutoff
				ORDER BY t.expires_at, t.id LIMIT v_batch_size FOR UPDATE SKIP LOCKED
			) c;
		WHEN 'oauth_refresh_token' THEN
			SELECT array_agg(c.id ORDER BY c.id COLLATE "C") INTO v_ids FROM (
				SELECT t.id::text AS id FROM public.oauth_refresh_token t
				WHERE COALESCE(t.revoked, t.expires_at) IS NOT NULL
					AND COALESCE(t.revoked, t.expires_at) < v_cutoff
				ORDER BY COALESCE(t.revoked, t.expires_at), t.id LIMIT v_batch_size FOR UPDATE SKIP LOCKED
			) c;
		WHEN 'command_receipt' THEN
			SELECT array_agg(c.id ORDER BY c.id COLLATE "C") INTO v_ids FROM (
				SELECT r.id::text AS id FROM public.command_receipts r
				WHERE r.expires_at < v_cutoff
				ORDER BY r.expires_at, r.id LIMIT v_batch_size FOR UPDATE SKIP LOCKED
			) c;
		WHEN 'slack_oauth_state' THEN
			SELECT array_agg(c.id ORDER BY c.id COLLATE "C") INTO v_ids FROM (
				SELECT s.id::text AS id FROM public.slack_oauth_states s
				WHERE s.expires_at < v_cutoff
					AND NOT EXISTS (
						SELECT 1 FROM public.retention_holds h
						WHERE h.organization_id = s.organization_id
							AND h.status = 'active'
							AND h.category IN ('all', 'slack_oauth_state')
					)
				ORDER BY s.expires_at, s.id LIMIT v_batch_size FOR UPDATE SKIP LOCKED
			) c;
		WHEN 'slack_action_token' THEN
			SELECT array_agg(c.id ORDER BY c.id COLLATE "C") INTO v_ids FROM (
				SELECT s.id::text AS id FROM public.slack_action_tokens s
				WHERE s.expires_at < v_cutoff
					AND NOT EXISTS (
						SELECT 1 FROM public.retention_holds h
						WHERE h.organization_id = s.organization_id
							AND h.status = 'active'
							AND h.category IN ('all', 'slack_action_token')
					)
				ORDER BY s.expires_at, s.id LIMIT v_batch_size FOR UPDATE SKIP LOCKED
			) c;
		WHEN 'provider_callback_receipt' THEN
			SELECT array_agg(c.id ORDER BY c.id COLLATE "C") INTO v_ids FROM (
				SELECT r.id::text AS id FROM public.provider_callback_receipts r
				WHERE r.received_at < v_cutoff
				ORDER BY r.received_at, r.id LIMIT v_batch_size FOR UPDATE SKIP LOCKED
			) c;
		WHEN 'rate_limit_bucket' THEN
			SELECT array_agg(c.id ORDER BY c.id COLLATE "C") INTO v_ids FROM (
				SELECT b.id::text AS id FROM public.rate_limit_buckets b
				WHERE b.expires_at < v_cutoff
				ORDER BY b.expires_at, b.id LIMIT v_batch_size FOR UPDATE SKIP LOCKED
			) c;
	END CASE;

	IF v_ids IS NULL THEN
		RETURN QUERY SELECT p_category, 0, NULL::uuid;
		RETURN;
	END IF;

	INSERT INTO public.retention_tombstones (category, cutoff_at, deleted_count, selected_ids_sha256, metadata)
	VALUES (
		p_category,
		v_cutoff,
		cardinality(v_ids),
		encode(sha256(convert_to(array_to_json(v_ids)::text, 'UTF8')), 'hex'),
		jsonb_build_object('batchSize', v_batch_size)
	)
	RETURNING id INTO v_tombstone_id;

	CASE p_category
		WHEN 'verification' THEN
			DELETE FROM public.verification v WHERE v.id = ANY (v_ids);
		WHEN 'session' THEN
			DELETE FROM public.session s WHERE s.id = ANY (v_ids);
		WHEN 'oauth_access_token' THEN
			DELETE FROM public.oauth_access_token t WHERE t.id = ANY (v_ids);
		WHEN 'oauth_refresh_token' THEN
			DELETE FROM public.oauth_refresh_token t WHERE t.id = ANY (v_ids);
		WHEN 'command_receipt' THEN
			DELETE FROM public.command_receipts r WHERE r.id = ANY (v_ids::uuid[]);
		WHEN 'slack_oauth_state' THEN
			DELETE FROM public.slack_oauth_states s WHERE s.id = ANY (v_ids::uuid[]);
		WHEN 'slack_action_token' THEN
			DELETE FROM public.slack_action_tokens s WHERE s.id = ANY (v_ids::uuid[]);
		WHEN 'provider_callback_receipt' THEN
			DELETE FROM public.provider_callback_receipts r WHERE r.id = ANY (v_ids::uuid[]);
		WHEN 'rate_limit_bucket' THEN
			DELETE FROM public.rate_limit_buckets b WHERE b.id = ANY (v_ids::uuid[]);
	END CASE;

	RETURN QUERY SELECT p_category, cardinality(v_ids), v_tombstone_id;
END;
$$;--> statement-breakpoint
-- §2.5.0 item 4: nobody but the roles named below may execute these.
REVOKE EXECUTE ON FUNCTION requestport_private.claim_outbox_batch(integer, integer) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.accept_outbox_claim(uuid, uuid, text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.release_outbox_claim(uuid, uuid, boolean, integer) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.claim_import_dispatch_batch(integer, integer) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.accept_import_dispatch_claim(uuid, uuid, text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.due_notification_intents(integer) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.pending_webhook_deliveries(integer) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.due_slack_message_updates(integer) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.due_slack_connection_tests(integer) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.lease_expired_work_sessions(integer) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.grace_expired_work_sessions(integer) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.due_webhook_secret_promotions(integer) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.due_question_reminders(integer) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.resolve_job_organization(text, uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.operational_metrics_snapshot() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.outbox_pending_backlog() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.retention_cleanup(text, integer) FROM PUBLIC;--> statement-breakpoint
-- §2.2: the new owner needs CREATE on the schema while ownership moves, and
-- only then (0019's P3).
GRANT CREATE ON SCHEMA requestport_private TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.claim_outbox_batch(integer, integer) OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.accept_outbox_claim(uuid, uuid, text) OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.release_outbox_claim(uuid, uuid, boolean, integer) OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.claim_import_dispatch_batch(integer, integer) OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.accept_import_dispatch_claim(uuid, uuid, text) OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.due_notification_intents(integer) OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.pending_webhook_deliveries(integer) OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.due_slack_message_updates(integer) OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.due_slack_connection_tests(integer) OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.lease_expired_work_sessions(integer) OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.grace_expired_work_sessions(integer) OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.due_webhook_secret_promotions(integer) OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.due_question_reminders(integer) OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.resolve_job_organization(text, uuid) OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.operational_metrics_snapshot() OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.outbox_pending_backlog() OWNER TO requestport_definer;--> statement-breakpoint
ALTER FUNCTION requestport_private.retention_cleanup(text, integer) OWNER TO requestport_definer;--> statement-breakpoint
REVOKE CREATE ON SCHEMA requestport_private FROM requestport_definer;--> statement-breakpoint
-- After ownership moved, never before (0019: a grant to the owner merges into
-- the owner's own entry, which the move then hands to the definer). The
-- migrating role keeps EXECUTE until b5, because b2's code calls these while
-- production still connects as the owner (§2.2, §5.2).
GRANT EXECUTE ON FUNCTION requestport_private.claim_outbox_batch(integer, integer) TO requestport_dispatcher, CURRENT_USER;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.accept_outbox_claim(uuid, uuid, text) TO requestport_dispatcher, CURRENT_USER;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.release_outbox_claim(uuid, uuid, boolean, integer) TO requestport_dispatcher, CURRENT_USER;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.claim_import_dispatch_batch(integer, integer) TO requestport_dispatcher, CURRENT_USER;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.accept_import_dispatch_claim(uuid, uuid, text) TO requestport_dispatcher, CURRENT_USER;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.due_notification_intents(integer) TO requestport_dispatcher, CURRENT_USER;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.pending_webhook_deliveries(integer) TO requestport_dispatcher, CURRENT_USER;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.due_slack_message_updates(integer) TO requestport_dispatcher, CURRENT_USER;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.due_slack_connection_tests(integer) TO requestport_dispatcher, CURRENT_USER;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.lease_expired_work_sessions(integer) TO requestport_dispatcher, CURRENT_USER;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.grace_expired_work_sessions(integer) TO requestport_dispatcher, CURRENT_USER;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.due_webhook_secret_promotions(integer) TO requestport_dispatcher, CURRENT_USER;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.due_question_reminders(integer) TO requestport_dispatcher, CURRENT_USER;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.resolve_job_organization(text, uuid) TO requestport_tenant_processor, CURRENT_USER;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.operational_metrics_snapshot() TO requestport_maintenance, CURRENT_USER;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.outbox_pending_backlog() TO requestport_maintenance, CURRENT_USER;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION requestport_private.retention_cleanup(text, integer) TO requestport_maintenance, CURRENT_USER;--> statement-breakpoint
-- D3: the definer holds only the table privileges its bodies use. 0019 gave
-- it what its fifteen bodies use; these are what the seventeen add. A row
-- lock needs UPDATE on at least one column (P10): where a body only locks,
-- that is UPDATE (id), as in 0019.
GRANT SELECT, UPDATE (state, lease_owner, lease_expires_at, trigger_run_id, accepted_at, attempt_count, next_attempt_at, updated_at) ON public.outbox TO requestport_definer;--> statement-breakpoint
GRANT SELECT, UPDATE (state, lease_owner, lease_expires_at, trigger_run_id, accepted_at, attempt_count, last_error_code, updated_at) ON public.import_task_dispatches TO requestport_definer;--> statement-breakpoint
GRANT SELECT ON public.domain_events, public.notification_intents, public.webhook_deliveries, public.webhook_attempts, public.webhook_subscriptions, public.slack_delivery_operations, public.work_sessions, public.requests, public.import_conflicts, public.retention_holds TO requestport_definer;--> statement-breakpoint
GRANT SELECT, DELETE, UPDATE (id) ON public.verification, public.session, public.oauth_access_token, public.oauth_refresh_token, public.command_receipts, public.rate_limit_buckets TO requestport_definer;--> statement-breakpoint
GRANT DELETE ON public.slack_oauth_states, public.slack_action_tokens, public.provider_callback_receipts TO requestport_definer;--> statement-breakpoint
GRANT SELECT (id), INSERT ON public.retention_tombstones TO requestport_definer;--> statement-breakpoint
GRANT SELECT ON requestport_private.retention_ages TO requestport_definer;--> statement-breakpoint
-- The tenant processor's grants (§5.1 Grants): the matrix in track-i2.md,
-- "I.2b design", derived from every statement a processing path issues.
-- Granted by table, except Better Auth's user, granted by the three columns
-- the processor reads.
-- No DELETE, TRUNCATE, REFERENCES or TRIGGER anywhere; nothing on account,
-- apikey, jwks, oauth_client, oauth_consent, session, verification,
-- oauth_access_token or oauth_refresh_token. Where a statement only locks a
-- row, the grant is UPDATE (id), as the application's is (D19).
GRANT SELECT, UPDATE (id) ON public.agent_credentials, public.agent_oauth_grants, public.agent_principals, public.import_sources, public.organization_members, public.organizations, public.project_members, public.projects, public.slack_installations, public.source_artifacts TO requestport_tenant_processor;--> statement-breakpoint
GRANT SELECT, INSERT ON public.command_receipts, public.domain_events, public.import_apply_reports, public.import_conflicts, public.import_entry_applications, public.import_manifest_entries, public.legacy_mappings, public.messages TO requestport_tenant_processor;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.email_deliveries, public.notification_intents, public.outbox, public.project_sequences, public.requests, public.slack_deliveries, public.webhook_attempts, public.webhook_deliveries TO requestport_tenant_processor;--> statement-breakpoint
GRANT SELECT, UPDATE ON public.import_runs, public.import_task_dispatches, public.slack_delivery_operations, public.source_snapshots, public.webhook_subscriptions, public.work_sessions TO requestport_tenant_processor;--> statement-breakpoint
GRANT SELECT ON public.invitations, public.questions, public.routing_rules, public.slack_routes, public.slack_user_mappings TO requestport_tenant_processor;--> statement-breakpoint
GRANT INSERT ON public.legacy_aliases, public.message_mentions, public.request_acceptance_criteria, public.request_labels, public.request_relationships, public.security_audit_records, public.slack_action_tokens, public.state_transitions TO requestport_tenant_processor;--> statement-breakpoint
GRANT SELECT (id, name, email) ON public."user" TO requestport_tenant_processor;
