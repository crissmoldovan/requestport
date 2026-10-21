import { declareDatabaseSurface } from "@requestport/db";

/*
 * The Trigger.dev worker's database surface (manifest-i2.md §2.2, ruling 45).
 * The worker has no single entry file — `trigger.config.ts` loads every file
 * under `./src` — so each of the 17 task modules imports this one first, and
 * whichever the worker loads first declares `worker` before anything in it
 * can query. The same declaration again is idempotent.
 */
declareDatabaseSurface("worker");
