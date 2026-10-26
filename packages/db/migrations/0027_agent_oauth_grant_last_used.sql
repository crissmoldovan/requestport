-- Ruling 261: when an agent last authenticated through OAuth. An API key's
-- use is stamped on agent_credentials.last_used_at; nothing recorded an OAuth
-- grant's, so the console could not say when an OAuth agent last signed in.
-- This adds the grant's own column, nullable and without a default, so no
-- existing row is rewritten and each reads null until its next use. The
-- bearer path stamps it as the application role, bound to the grant's
-- organisation, at most once every five minutes (`touchOAuthGrant`).
--
-- Bound the lock first. ADD COLUMN takes ACCESS EXCLUSIVE on
-- agent_oauth_grants, which every OAuth request reads and every agent
-- command locks FOR SHARE; it rewrites no row, so a granted lock is held for
-- milliseconds. As in 0017 and 0022, 5s lets short transactions drain, and a
-- timeout rolls the apply back whole, so it can simply be run again.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "agent_oauth_grants" ADD COLUMN "last_used_at" timestamp with time zone;
