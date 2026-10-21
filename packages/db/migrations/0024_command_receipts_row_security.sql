-- requestport: this migration must be the last one applied in its transaction
-- Plan 13, Track I.2, step 8: the receipts contract (docs/implementation/
-- plans/2026-09-27-13/manifest-i2.md §2.1, §2.3, §3 step 8; r9-rulings.md
-- 17 (open question 6), 200 and 220).
--
-- command_receipts gets the one policy §2.1 gives it, and then ENABLE and
-- FORCE ROW LEVEL SECURITY. With an organisation bound, a receipt is visible
-- and writable only when its organization_id is that organisation. With none
-- bound, only when its organization_id is NULL: the session-only user bus
-- binds a user alone, and its receipts carry no organisation. The binding is
-- read as security_audit_records' WITH CHECK reads it (0019, track-i2.md
-- D12), through nullif(current_setting(...)), and not through
-- bound_organization_id(), which raises when no organisation is bound and so
-- would refuse the user bus (D1). It is the expression every receipt insert
-- writes organization_id from (boundOrganizationIdSql, tenant-context.ts).
-- No row is changed and nothing is dropped.
--
-- Whom it binds. The policy names no role, as none of 0019's does, so it
-- applies to every role that does not bypass row security: the application
-- group and the tenant processor. FORCE applies it to the table's owner as
-- well, unless the owner bypasses it: production's owner has BYPASSRLS; a
-- self-host's owner is a superuser or has BYPASSRLS, or its
-- first start refuses it; the local requestport role is a superuser, and so
-- is PGlite's one session. requestport_definer has BYPASSRLS, so
-- retention_cleanup (0020), which runs as it, still deletes the expired
-- receipts of every organisation, and of none.
--
-- Where the lock is (track-i2.md, "I.2 step 8", the lock probe). CREATE
-- POLICY and both ALTER TABLEs take ACCESS EXCLUSIVE on command_receipts, and
-- nothing else, from the first of them to the commit. Every command reads
-- and writes that table. While the lock waits for a transaction that holds
-- the table, every later reader and writer of it queues behind the wait
-- (measured). The line below bounds the wait at 5 seconds, as 0017 and 0022
-- bound theirs: short transactions drain, and a timeout rolls the apply back
-- whole, so it can simply be run again.
--
-- The first line marks it (scripts/migration-support.mjs,
-- LAST_IN_TRANSACTION_MARKER). Drizzle's migrator applies every pending
-- migration in one transaction, so a later migration applied with this one
-- would inherit this lock_timeout, and would run while this ACCESS
-- EXCLUSIVE lock is held: a command that holds a lock that migration waits
-- for, and then queues for command_receipts, closes a deadlock cycle with
-- it. The next migration planned, step 5's contract, locks the tenant
-- tables every command reads before it reads command_receipts.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE POLICY requestport_tenant ON public."command_receipts"
	USING (
		CASE
			WHEN nullif(pg_catalog.current_setting('requestport.organization_id', true), '') IS NOT NULL
				THEN organization_id = nullif(pg_catalog.current_setting('requestport.organization_id', true), '')::uuid
			ELSE organization_id IS NULL
		END
	)
	WITH CHECK (
		CASE
			WHEN nullif(pg_catalog.current_setting('requestport.organization_id', true), '') IS NOT NULL
				THEN organization_id = nullif(pg_catalog.current_setting('requestport.organization_id', true), '')::uuid
			ELSE organization_id IS NULL
		END
	);--> statement-breakpoint
ALTER TABLE public."command_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public."command_receipts" FORCE ROW LEVEL SECURITY;
