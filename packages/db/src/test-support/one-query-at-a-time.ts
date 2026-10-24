import { createRequire } from "node:module";
import type * as Pg from "pg";
import { afterAll, afterEach, expect } from "vitest";

import {
  type ConcurrentQuery,
  guardState,
  queryText,
  recordConcurrentQuery,
  takeConcurrentQueries,
} from "./concurrent-queries.js";

/*
 * One query at a time on a connection (Plan 13, X24; ruling 202 item 2).
 *
 * `pg` 8 queues a query issued on a client that is still running one, and
 * runs them in turn. When its queue already holds one it also prints, once a
 * process, "Calling client.query() when the client is already executing a
 * query is deprecated and will be removed in pg@9.0"
 * (`pg@8.23.0/lib/client.js:761-763`). A tenant read runs on one transaction,
 * which is one client, so a repository that hands it several selects at once
 * (`Promise.all`) does exactly that. Its reads run in turn instead
 * (`../in-turn.ts`).
 *
 * This is the Vitest setup that keeps it so, loaded by this package's
 * configurations (`vitest.config.ts`, and so its PGlite lane, and
 * `vitest.application-role.config.ts`) and, since X25 (ruling 231), by
 * `apps/web`'s node project, `packages/core`'s configuration and
 * `packages/jobs`' integration project and worker-role lane, and since X25's
 * remainder (ruling 232 item 7) by `packages/auth`'s configuration. Loaded
 * from another workspace it patches the same `pg`: it requires `pg` from
 * this package, which is where every storage those suites build loads it
 * from.
 * It replaces `pg`'s
 * `Client.prototype.query`, which every pg client inherits, the storage's
 * `IsolatedPgClient` (`../client.ts`) among them, with one that records a
 * query issued on a client while another query it was handed is in flight:
 * its promise has not settled, or its callback has not been called. That is
 * stricter than pg's notice, which counts the queries waiting behind the one
 * running: on a client that is ready, this fires on the second query at
 * once, pg on the third. The query still runs, as pg would run it. The next
 * `afterEach` then fails its case, naming each recorded query and the ones it
 * overlapped; a query recorded outside any case fails whichever `afterEach`
 * or `afterAll` runs next.
 *
 * What it does not see: PGlite and the hosted driver, whose clients are not
 * `pg`'s; a submittable query (an object with `submit`) or one whose
 * callback is in its configuration object, which it checks against the
 * queries in flight but does not count as in flight itself (a search of
 * packages, apps, trigger and scripts for `submit(` and `callback:` found
 * neither handed to a pg client); a site no suite runs, which is why
 * `../one-query-at-a-time.integration.test.ts` also sweeps the source; and,
 * on a transaction `queueQueriesOn` queues (`queue-queries.ts`), an overlap
 * in which one of the queries names a table of Better Auth's, which it
 * queues and does not record, RequestPort's own queries on those tables
 * included. `packages/auth`'s five suites that compose Better Auth over a
 * rollback transaction put it on for each case: `cross-audience-token`,
 * `better-auth-legacy-rows`, `dynamic-client-registration`,
 * `operator-bearer` and `server-wiring`. Test support only; nothing shipped
 * imports it.
 */

export {
  type ConcurrentQuery,
  takeConcurrentQueries,
} from "./concurrent-queries.js";

/*
 * Held on the prototype it patches, which `pg` evaluates once a process
 * while Vitest evaluates this setup again for each test file
 * (`concurrent-queries.ts` holds the records on the global object for the
 * same reason).
 */
const PATCHED = Symbol.for("requestport.db.test.oneQueryAtATime.patched");

type Query = (this: object, ...args: unknown[]) => unknown;

/** Patch `Client.prototype.query` once a process. */
function guardOneQueryAtATime(Client: typeof Pg.Client): void {
  const prototype = Client.prototype as unknown as {
    query: Query;
    [PATCHED]?: true;
  };

  if (prototype[PATCHED]) return;

  const original = prototype.query;
  const inFlight = new WeakMap<object, Map<number, string>>();
  let nextId = 0;

  prototype.query = function guardedQuery(this: object, ...args: unknown[]) {
    const running = inFlight.get(this) ?? new Map<number, string>();
    const issued = queryText(args[0]);

    inFlight.set(this, running);
    if (running.size > 0) recordConcurrentQuery(issued, [...running.values()]);

    const config = args[0] as { submit?: unknown; callback?: unknown } | null;
    if (
      typeof config === "object" &&
      config !== null &&
      (typeof config.submit === "function" ||
        typeof config.callback === "function")
    ) {
      return original.apply(this, args);
    }

    const id = nextId++;
    const settle = () => {
      running.delete(id);
    };
    const last = args.length - 1;
    const callback = args[last];

    running.set(id, issued);
    if (typeof callback === "function") {
      args[last] = (...results: unknown[]) => {
        settle();
        return (callback as (...values: unknown[]) => unknown)(...results);
      };
    }

    let result: unknown;
    try {
      result = original.apply(this, args);
    } catch (error) {
      settle();
      throw error;
    }
    if (typeof callback === "function") return result;
    if (result instanceof Promise) return result.finally(settle);
    settle();
    return result;
  };
  prototype[PATCHED] = true;
}

function describeConcurrentQueries(found: readonly ConcurrentQuery[]) {
  return found
    .map(
      (query, index) =>
        `${index + 1}. issued while ${query.inFlight.length} other(s) on the same client were in flight` +
        ` (test: ${query.test ?? "none"}):\n     ${query.issued.slice(0, 240)}\n` +
        query.inFlight
          .map((text) => `     in flight: ${text.slice(0, 240)}`)
          .join("\n"),
    )
    .join("\n");
}

function failOnConcurrentQueries() {
  const found = takeConcurrentQueries();

  if (found.length > 0) {
    throw new Error(
      `RequestPort runs one query at a time on a client (X24): ${found.length} ` +
        "query(ies) were issued on a client while another was in flight. Run " +
        "them in turn (packages/db/src/in-turn.ts).\n" +
        describeConcurrentQueries(found),
    );
  }
}

const requireFromHere = createRequire(import.meta.url);

guardOneQueryAtATime((requireFromHere("pg") as typeof Pg).Client);
guardState().currentTest = () => expect.getState().currentTestName;

afterEach(failOnConcurrentQueries);
afterAll(failOnConcurrentQueries);
