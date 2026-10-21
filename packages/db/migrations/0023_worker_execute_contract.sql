-- Plan 13, Track I.2b, step b5: the contract on the worker's seventeen
-- functions (manifest-i2.md §5.1's 1 to 17, §5.2 b5; r9-rulings.md, ruling
-- 214 item 4; track-i2.md, "I.2b b5, the survey (2026-10-16)" §(d)).
--
-- 0020 granted EXECUTE on each of the seventeen to its one worker group and
-- to the migrating role, CURRENT_USER, because b2's code called them while
-- production's worker still connected as the owner. Since b3 (2026-10-02)
-- the Trigger.dev worker has connected as its three logins, and since b5's
-- code the worker's storages refuse to run without them (ruling 214 item
-- 1). No function or trigger body in these migrations calls any of the
-- seventeen. So this revokes what is left of the owner's path to them, in
-- two parts:
--
-- 1. From CURRENT_USER, the grant 0020 made, whatever the migrating role is
--    named.
-- 2. From requestport_definer, the functions' owner, its own entry. 0019
--    made the migrating role a member of requestport_definer WITH INHERIT
--    TRUE, so with part 1 alone it still executes every one of the seventeen
--    through the owner's entry (measured on an owner-shaped role, survey
--    §(d), candidate A). An owner can always grant again; a body still runs
--    as requestport_definer, and none calls one of these.
--
-- Afterwards each function's whole ACL is its group's entry, granted by the
-- owner. A superuser is unaffected, because a superuser passes every
-- privilege check: the local stack's migrating role and PGlite's are
-- superusers. No CASCADE: no entry here carries a grant option.
--
-- Where the locks are. Each REVOKE changes one function's ACL in pg_proc,
-- and the closing check only reads. None names a table, so none rewrites a
-- table's pg_class row, and this file carries no last-in-transaction marker
-- (0020's reason does not apply) and no lock_timeout. Measured on an
-- owner-shaped role (track-i2.md, "I.2b b5, slice S4"): applied beside a
-- worker login's open transaction that had called one of the seventeen, it
-- did not wait, and a worker login's call made while it was uncommitted did
-- not wait either.
--
-- A REVOKE that the migrating role cannot act on only warns ("no privileges
-- could be revoked"). So the last statement checks the result, and its
-- exception rolls the migration back: each function's ACL must be exactly
-- its group's entry, and a migrating role that is not a superuser must not
-- be able to execute any of the seventeen by any path, an inheriting
-- membership in a worker group among them. With each ACL exactly its
-- group's, that membership is the only path left, so the second refusal
-- names it, and names the setting that gives one: a server whose
-- createrole_self_grant includes inherit gives a CREATEROLE role that is
-- not a superuser an inheriting membership in each role it creates, and
-- requestport start's owner creates the groups where they do not exist
-- (ruling 215 item 10). PostgreSQL's default is empty.
--
-- Part 1: 0020's grant to the migrating role.
REVOKE EXECUTE ON FUNCTION requestport_private.claim_outbox_batch(integer, integer) FROM CURRENT_USER;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.accept_outbox_claim(uuid, uuid, text) FROM CURRENT_USER;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.release_outbox_claim(uuid, uuid, boolean, integer) FROM CURRENT_USER;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.claim_import_dispatch_batch(integer, integer) FROM CURRENT_USER;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.accept_import_dispatch_claim(uuid, uuid, text) FROM CURRENT_USER;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.due_notification_intents(integer) FROM CURRENT_USER;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.pending_webhook_deliveries(integer) FROM CURRENT_USER;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.due_slack_message_updates(integer) FROM CURRENT_USER;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.due_slack_connection_tests(integer) FROM CURRENT_USER;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.lease_expired_work_sessions(integer) FROM CURRENT_USER;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.grace_expired_work_sessions(integer) FROM CURRENT_USER;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.due_webhook_secret_promotions(integer) FROM CURRENT_USER;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.due_question_reminders(integer) FROM CURRENT_USER;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.resolve_job_organization(text, uuid) FROM CURRENT_USER;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.operational_metrics_snapshot() FROM CURRENT_USER;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.outbox_pending_backlog() FROM CURRENT_USER;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.retention_cleanup(text, integer) FROM CURRENT_USER;--> statement-breakpoint
-- Part 2: the owner's own entry, through which the migrating role
-- inherits EXECUTE (0019's membership).
REVOKE EXECUTE ON FUNCTION requestport_private.claim_outbox_batch(integer, integer) FROM requestport_definer;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.accept_outbox_claim(uuid, uuid, text) FROM requestport_definer;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.release_outbox_claim(uuid, uuid, boolean, integer) FROM requestport_definer;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.claim_import_dispatch_batch(integer, integer) FROM requestport_definer;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.accept_import_dispatch_claim(uuid, uuid, text) FROM requestport_definer;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.due_notification_intents(integer) FROM requestport_definer;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.pending_webhook_deliveries(integer) FROM requestport_definer;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.due_slack_message_updates(integer) FROM requestport_definer;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.due_slack_connection_tests(integer) FROM requestport_definer;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.lease_expired_work_sessions(integer) FROM requestport_definer;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.grace_expired_work_sessions(integer) FROM requestport_definer;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.due_webhook_secret_promotions(integer) FROM requestport_definer;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.due_question_reminders(integer) FROM requestport_definer;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.resolve_job_organization(text, uuid) FROM requestport_definer;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.operational_metrics_snapshot() FROM requestport_definer;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.outbox_pending_backlog() FROM requestport_definer;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION requestport_private.retention_cleanup(text, integer) FROM requestport_definer;--> statement-breakpoint
-- The postcondition. The list is 0020's seventeen, each with its group.
DO $$
DECLARE
	worker record;
	acl text[];
	migrating_superuser constant boolean := coalesce(
		(SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user),
		false
	);
BEGIN
	FOR worker IN
		SELECT f.signature::pg_catalog.regprocedure AS fn, f.grp
		FROM (VALUES
			('requestport_private.claim_outbox_batch(integer, integer)', 'requestport_dispatcher'),
			('requestport_private.accept_outbox_claim(uuid, uuid, text)', 'requestport_dispatcher'),
			('requestport_private.release_outbox_claim(uuid, uuid, boolean, integer)', 'requestport_dispatcher'),
			('requestport_private.claim_import_dispatch_batch(integer, integer)', 'requestport_dispatcher'),
			('requestport_private.accept_import_dispatch_claim(uuid, uuid, text)', 'requestport_dispatcher'),
			('requestport_private.due_notification_intents(integer)', 'requestport_dispatcher'),
			('requestport_private.pending_webhook_deliveries(integer)', 'requestport_dispatcher'),
			('requestport_private.due_slack_message_updates(integer)', 'requestport_dispatcher'),
			('requestport_private.due_slack_connection_tests(integer)', 'requestport_dispatcher'),
			('requestport_private.lease_expired_work_sessions(integer)', 'requestport_dispatcher'),
			('requestport_private.grace_expired_work_sessions(integer)', 'requestport_dispatcher'),
			('requestport_private.due_webhook_secret_promotions(integer)', 'requestport_dispatcher'),
			('requestport_private.due_question_reminders(integer)', 'requestport_dispatcher'),
			('requestport_private.resolve_job_organization(text, uuid)', 'requestport_tenant_processor'),
			('requestport_private.operational_metrics_snapshot()', 'requestport_maintenance'),
			('requestport_private.outbox_pending_backlog()', 'requestport_maintenance'),
			('requestport_private.retention_cleanup(text, integer)', 'requestport_maintenance')
		) AS f (signature, grp)
	LOOP
		SELECT p.proacl::text[] INTO acl
		FROM pg_catalog.pg_proc p
		WHERE p.oid = worker.fn;
		IF acl IS DISTINCT FROM ARRAY[worker.grp || '=X/requestport_definer'] THEN
			RAISE EXCEPTION 'requestport: % is executable by %, expected its group alone', worker.fn, acl;
		END IF;
		IF NOT migrating_superuser
			AND pg_catalog.has_function_privilege(current_user, worker.fn, 'EXECUTE') THEN
			RAISE EXCEPTION 'requestport: the migrating role % can still execute %, through an inheriting membership in its group %. A server whose createrole_self_grant includes inherit gives a role that is not a superuser such a membership in each role it creates: take the inherit option off it, or migrate as a role without one.', current_user, worker.fn, worker.grp;
		END IF;
	END LOOP;
END $$;
