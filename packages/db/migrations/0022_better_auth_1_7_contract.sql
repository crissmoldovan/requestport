-- Plan 13, K.4: the contract after K.2's expand (0017). It drops the two
-- oauth_client columns Better Auth 1.7.6 has no field for: `public`, which
-- 1.6.29 wrote as exactly "token_endpoint_auth_method is `none`", and `type`,
-- which 0017 copied into `application_type` where it held 'web' or 'native'.
-- Nothing in this tree reads or writes them on this table (track-k.md, K.4,
-- names the one test that rebuilds them in a scratch copy of 0016's table).
-- The code that stops declaring them deploys before this is applied: under a
-- tree that still declares them, Better Auth's Drizzle adapter names both in
-- every oauth_client read and insert, and fails against a database without
-- them. Before the apply, the driver runs the read-only count recorded in
-- track-k.md, K.4.
--
-- Bound the lock first. DROP COLUMN takes ACCESS EXCLUSIVE on oauth_client,
-- which every OAuth request reads; it rewrites no row, so a granted lock is
-- held for milliseconds. As in 0017, 5s lets short transactions drain, and a
-- timeout rolls the apply back whole, so it can simply be run again. No
-- CASCADE: an object that still depended on either column would stop the
-- apply rather than go with it.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "oauth_client" DROP COLUMN "public";--> statement-breakpoint
ALTER TABLE "oauth_client" DROP COLUMN "type";