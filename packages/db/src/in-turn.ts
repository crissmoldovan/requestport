/*
 * Reads run one after another on one transaction (Plan 13, X24; ruling 202
 * item 2).
 *
 * A transaction is one connection, so `pg` can run only one of its queries
 * at a time. Handed several at once, as `Promise.all` over a transaction's
 * selects hands them, it queues them and runs them in the order they
 * arrived. When a query arrives while another is already waiting, it also
 * prints, once a process, "Calling client.query() when the client is already
 * executing a query is deprecated and will be removed in pg@9.0"
 * (`pg@8.23.0/lib/client.js:761-763`). The hosted driver's client queues
 * them the same way, without the notice.
 *
 * `inTurn` starts each read once the one before it has settled, in the order
 * given, and resolves to their results in that order, as `Promise.all` does.
 * When each read is one statement, as each caller here is, each query
 * therefore reaches the connection in the same order, with the same
 * statements before it, as when `pg` queued them. The first read to reject
 * rejects it, and the reads after it are not started. When the failure is
 * PostgreSQL's, in a transaction they could only have failed, because
 * PostgreSQL refuses every statement after a failed one until the
 * transaction, or the savepoint it is in, is rolled back. Each read is a function, so that nothing runs before its turn: a
 * Drizzle query starts when it is awaited, but a promise is already running
 * when it is made.
 */

type Read = () => PromiseLike<unknown>;

/** What `inTurn` resolves to: each read's result, in order. */
export type ReadResults<Reads extends readonly Read[]> = {
  -readonly [Index in keyof Reads]: Reads[Index] extends () => infer Result
    ? Awaited<Result>
    : never;
};

export async function inTurn<const Reads extends readonly Read[]>(
  reads: Reads,
): Promise<ReadResults<Reads>> {
  const results: unknown[] = [];

  for (const read of reads) results.push(await read());
  return results as ReadResults<Reads>;
}
