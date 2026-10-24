import { getTableName } from "drizzle-orm";

import { identitySchema } from "../schema/identity.js";
import type { Tx } from "../transaction.js";
import { queryText, recordConcurrentQuery } from "./concurrent-queries.js";

type Query = (...args: unknown[]) => unknown;

/**
 * The tables Better Auth's adapter is handed (`identitySchema`), each as a
 * query names it: quoted, as Drizzle writes every identifier.
 */
const BETTER_AUTH_TABLES = Object.values(identitySchema).map(
  (table) => `"${getTableName(table)}"`,
);

/**
 * Whether a query's text holds the name of one of Better Auth's tables,
 * quoted, anywhere: a quoted column or alias spelled the same counts too.
 */
export function namesBetterAuthTable(text: string): boolean {
  return BETTER_AUTH_TABLES.some((name) => text.includes(name));
}

/**
 * Hands the one `pg` client a test's transaction runs on one query at a
 * time: each query issued on it starts once every query issued before it
 * has settled, in the order they were issued. It answers a function that
 * puts the client back as it was, which the test calls before its
 * transaction ends, because the client then goes back to the pool (Plan 13,
 * X25's remainder; ruling 232 item 7).
 *
 * For a test that composes a library over its own rollback transaction:
 * `packages/auth`'s suites build Better Auth over one (`drizzleAdapter(tx)`).
 * Better Auth issues some queries at once (`Promise.all` in its token
 * endpoint) and some in the background (its API key plugin's sweep of expired
 * keys, its OAuth provider's seeding of resources as an instance starts).
 * Composed over a pool, as production composes it, each of those takes a
 * client of its own. Composed over one transaction, they all land on its one
 * client, where `pg` 8 queues them itself, and deprecates doing so, and the
 * overlap guard fails the case (`one-query-at-a-time.ts`). Queued here, in
 * the order `pg` 8 would have run them, the client is handed none while
 * another is in flight.
 *
 * It still records, for the guard, an overlap the guard would have recorded
 * (`concurrent-queries.ts`): a query issued here while others issued here
 * have not settled. It records one only where that query names no table of
 * Better Auth's (`namesBetterAuthTable`) and at least one of those names
 * none either, and lists only those that name none. So an overlap between
 * two of RequestPort's own queries on its own tables still fails the case.
 *
 * What it costs: it cannot tell whose a query is, only which tables it
 * names. A query that names a table of Better Auth's is never recorded,
 * issued or in flight, RequestPort's own queries on those tables (`user`,
 * `session`, `apikey`, the OAuth provider's) included, so an overlap
 * between it and any other query is queued and not recorded. A query that
 * names one without quotes is judged RequestPort's, which can only add a
 * record.
 *
 * It reaches the client through Drizzle's node-postgres transaction, whose
 * session holds it as `client` (`drizzle-orm` 0.45.2,
 * `node-postgres/session.js`), and refuses a transaction that holds none
 * there, so a Drizzle that moves it fails here rather than queueing nothing.
 * A query handed with a callback, or as a submittable, is passed on as it
 * comes, neither queued nor judged here (the guard judges it): Drizzle hands
 * neither.
 */
export function queueQueriesOn(transaction: Tx): () => void {
  const client = (
    transaction as unknown as { session?: { client?: Record<string, unknown> } }
  ).session?.client;

  if (client === undefined || typeof client.query !== "function") {
    throw new Error(
      "queueQueriesOn: this transaction holds no pg client at session.client",
    );
  }

  const owned = Object.hasOwn(client, "query");
  const previous = client.query as Query;
  // Each query issued here that has not settled, by the order it was issued.
  const unsettled = new Map<number, string>();
  let nextId = 0;
  let tail: Promise<unknown> = Promise.resolve();

  client.query = (...args: unknown[]) => {
    const config = args[0] as { submit?: unknown } | null;

    if (
      typeof args.at(-1) === "function" ||
      (typeof config === "object" &&
        config !== null &&
        typeof config.submit === "function")
    ) {
      return previous.apply(client, args);
    }

    const issued = queryText(args[0]);

    if (!namesBetterAuthTable(issued)) {
      const overlapped = [...unsettled.values()].filter(
        (text) => !namesBetterAuthTable(text),
      );

      if (overlapped.length > 0) recordConcurrentQuery(issued, overlapped);
    }

    const id = nextId++;
    const settle = () => {
      unsettled.delete(id);
    };
    const result = tail.then(() => previous.apply(client, args));

    unsettled.set(id, issued);
    tail = result.then(settle, settle);
    return result;
  };

  return () => {
    if (owned) client.query = previous;
    else delete client.query;
  };
}
