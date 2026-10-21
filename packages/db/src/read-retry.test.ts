import type { Pool } from "pg";
import { describe, expect, test, vi } from "vitest";

import {
  isConnectionFailure,
  isRetryableRead,
  withReadRetry,
} from "./read-retry.js";

/** What the driver really rejects with: its WebSocket's own error event. */
class DriverErrorEvent {
  readonly type = "error";
}

describe("telling a dropped connection from a refused query", () => {
  test("the object the driver actually rejects with is recognised", () => {
    /*
     * The defect this closes. Not that the retry never fired — it fired for a
     * socket that died mid-query, which rejects with a plain
     * `Error("Connection terminated unexpectedly")`. It was inert for the
     * *`ErrorEvent`* shape, which is what a connection refused at the upgrade
     * produces, and which is what the measured incident produced. The
     * `Failed query: … [cause]: ErrorEvent` quoted in the evidence is
     * *Drizzle's* wrapper, built above the pool. What the patched `pool.query`
     * catches is the driver's raw rejection, and for a WebSocket error that is
     * the event itself — an `Event`, not an `Error`. An `instanceof Error` gate
     * refused it, so the shape the fix was written for was the one shape it
     * could not see.
     */
    const event = new DriverErrorEvent();

    expect(event instanceof Error).toBe(false);
    expect(isConnectionFailure(event)).toBe(true);
  });

  test("the driver's own words when a socket dies", () => {
    expect(
      isConnectionFailure(
        new Error(
          "All attempts to open a WebSocket to connect to the database failed",
        ),
      ),
    ).toBe(true);
    expect(
      isConnectionFailure(new Error("Connection terminated unexpectedly")),
    ).toBe(true);
  });

  test("a socket error whose code looks like a SQLSTATE is still a socket error", () => {
    // `EPIPE` is five capitals, which the old shape test read as a SQLSTATE and
    // refused — declaring a dead socket to be a query the server answered.
    expect(
      isConnectionFailure(
        Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
      ),
    ).toBe(true);
  });

  test("a bare ErrorEvent cause is the WebSocket dying", () => {
    // Measured: `Failed query: select "agent_principals"…` with
    // `[cause]: ErrorEvent { type: 'error' }`, from the driver's socket
    // closing mid-render. The proxy logged one abnormal close in that minute
    // against fifteen normal ones, and PostgreSQL logged nothing at all.
    const error = new Error("Failed query: select 1", {
      cause: { type: "error" },
    });

    expect(isConnectionFailure(error)).toBe(true);
  });

  test("the socket's own words count too", () => {
    for (const message of [
      "terminated",
      "socket hang up",
      "Connection terminated unexpectedly",
      "read ECONNRESET",
      "write EPIPE",
      "WebSocket was closed before the connection was established",
    ]) {
      expect(isConnectionFailure(new Error(message)), message).toBe(true);
    }
  });

  test("a query the server refused is never a connection failure", () => {
    /*
     * The discriminator that matters. A server-side error carries a SQLSTATE;
     * a dead socket does not. Retrying a constraint violation would turn one
     * honest failure into two, and retrying a statement timeout would double
     * the load that caused it.
     */
    for (const [code, message] of [
      ["23505", "duplicate key value violates unique constraint"],
      ["42601", "syntax error at or near"],
      ["42P01", 'relation "nope" does not exist'],
      ["57014", "canceling statement due to statement timeout"],
      ["40001", "could not serialize access due to concurrent update"],
    ]) {
      const error = Object.assign(new Error(message), { code });

      expect(isConnectionFailure(error), code).toBe(false);
    }
  });

  test("an unrecognised error is not retried", () => {
    // The safe default: a failure nobody has characterised is reported, not
    // repeated.
    expect(isConnectionFailure(new Error("something else entirely"))).toBe(
      false,
    );
    expect(isConnectionFailure("not an error")).toBe(false);
    expect(isConnectionFailure(undefined)).toBe(false);
  });
});

describe("telling a read from anything that writes", () => {
  test("a plain select is retryable", () => {
    expect(isRetryableRead("select 1")).toBe(true);
    expect(isRetryableRead("  SELECT id FROM projects WHERE id = $1")).toBe(
      true,
    );
  });

  test("a column named like a verb does not make a read a write", () => {
    // `updated_at` is in half the tables here. A word-boundary match on
    // `update` must not claim it.
    expect(
      isRetryableRead('select "agent_principals"."updated_at" from x'),
    ).toBe(true);
    expect(isRetryableRead("select deleted_at, inserted_by from x")).toBe(true);
  });

  test("refuses the mutating statements a bare keyword list let through", () => {
    /*
     * Every one of these began `select`, carried none of the original writing
     * keywords, and was admitted — while the comment beside the guard promised
     * it admitted no write at all.
     */
    for (const statement of [
      "select * into audit_copy from audit_log",
      "select 1; truncate table sessions",
      "select 1; drop table users",
      "select 1; alter table users add column x int",
      "select 1; grant all on users to public",
      "select pg_advisory_lock(42)",
      "select pg_terminate_backend(pid) from pg_stat_activity",
      "select set_config($1, $2, false)",
      "select 1; call do_the_thing()",
      "select 1; refresh materialized view m",
      "select 1; copy users from '/tmp/x'",
    ]) {
      expect(isRetryableRead(statement), statement).toBe(false);
    }
  });

  test("a second statement is refused even when it names nothing forbidden", () => {
    // What makes the multi-statement check its own guard: every other case
    // above also trips the keyword list, so the list alone refused them and
    // this check went unexercised.
    for (const statement of [
      "select 1; begin",
      "select 1; commit",
      "select 1; set search_path = elsewhere",
      "select 1; notify channel, 'x'",
    ]) {
      expect(isRetryableRead(statement), statement).toBe(false);
    }
  });

  test("refuses every spelling of an advisory lock, not just one", () => {
    /*
     * `\bpg_advisory_lock\b` cannot match `pg_advisory_xact_lock` — `_` is a
     * word character, so there is no boundary — and `pg_advisory_xact_lock` is
     * the spelling this repository actually uses. Every site is inside a
     * transaction today, which never reaches this guard, so the hole was
     * latent; the list was one spelling wide in exactly the family the code
     * depends on.
     */
    for (const statement of [
      "select pg_advisory_lock(42)",
      "select pg_advisory_xact_lock(42)",
      "select pg_try_advisory_lock(42)",
      "select pg_try_advisory_xact_lock(42)",
      "select pg_advisory_unlock(42)",
      "select pg_advisory_unlock_all()",
      "select pg_advisory_lock_shared(42)",
    ]) {
      expect(isRetryableRead(statement), statement).toBe(false);
    }
  });

  test("refuses the other functions that change something from inside a select", () => {
    for (const statement of [
      "select pg_notify('requests', $1)",
      "select pg_logical_emit_message(true, $1, $2)",
      "select lo_create(0)",
      "select lo_unlink($1)",
      "select dblink_exec($1, $2)",
      "select txid_current()",
      "select setseed(0.5)",
      "select pg_stat_reset()",
      "select pg_reload_conf()",
    ]) {
      expect(isRetryableRead(statement), statement).toBe(false);
    }
  });

  test("a trailing semicolon is not a second statement", () => {
    expect(isRetryableRead("select 1;")).toBe(true);
    expect(isRetryableRead("select 1;  \n")).toBe(true);
  });

  test("anything that writes is never retried", () => {
    for (const statement of [
      "insert into x (a) values (1)",
      "update x set a = 1",
      "delete from x",
      "merge into x using y on true",
      "with moved as (delete from x returning *) select * from moved",
      "select nextval('s')",
    ]) {
      expect(isRetryableRead(statement), statement).toBe(false);
    }
  });

  test("a locking read belongs to a transaction, so it is not retried", () => {
    expect(isRetryableRead("select * from x for update")).toBe(false);
    expect(isRetryableRead("select * from x for no key update")).toBe(false);
    expect(isRetryableRead("select * from x for share")).toBe(false);
  });

  test("transaction control is never retried", () => {
    for (const statement of ["begin", "commit", "rollback", "savepoint s"]) {
      expect(isRetryableRead(statement), statement).toBe(false);
    }
  });

  test("reads the statement out of a query config, not only a string", () => {
    expect(isRetryableRead({ text: "select 1" })).toBe(true);
    expect(isRetryableRead({ text: "delete from x" })).toBe(false);
    expect(isRetryableRead(undefined)).toBe(false);
  });
});

describe("retrying the read once", () => {
  const dropped = () => new Error("terminated");

  /** The only part of a pool this patch touches. */
  const poolOf = (query: ReturnType<typeof vi.fn>) =>
    ({ query }) as unknown as Pool;

  test("a read that lost its connection is asked again", async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(dropped())
      .mockResolvedValueOnce({ rows: [{ id: 1 }] });
    const pool = withReadRetry(poolOf(query));

    await expect(pool.query("select 1")).resolves.toEqual({
      rows: [{ id: 1 }],
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  test("once, and only once", async () => {
    // A connection that is gone stays gone; repeating past one attempt turns a
    // dropped socket into a stall.
    const query = vi.fn().mockRejectedValue(dropped());
    const pool = withReadRetry(poolOf(query));

    await expect(pool.query("select 1")).rejects.toThrow("terminated");
    expect(query).toHaveBeenCalledTimes(2);
  });

  test("a write is never asked again", async () => {
    const query = vi.fn().mockRejectedValue(dropped());
    const pool = withReadRetry(poolOf(query));

    await expect(pool.query("insert into x (a) values (1)")).rejects.toThrow(
      "terminated",
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  test("a refused query is never asked again", async () => {
    const query = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("duplicate key"), { code: "23505" }),
      );
    const pool = withReadRetry(poolOf(query));

    await expect(pool.query("select 1")).rejects.toThrow("duplicate key");
    expect(query).toHaveBeenCalledTimes(1);
  });

  test("says when it heals something, because a silent retry hides a fault", async () => {
    /*
     * The lane's own record argues that a retry "would have hidden every one of
     * these while leaving them in the stack". This retry sits one layer below
     * the detector written to surface exactly these drops, so it has to say so
     * — otherwise a healed run and a healthy one are indistinguishable, and a
     * rate going from one-in-two-hundred to one-in-five looks like silence.
     */
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const query = vi
      .fn()
      .mockRejectedValueOnce(dropped())
      .mockResolvedValueOnce({ rows: [] });

    await withReadRetry(poolOf(query)).query("select 1");

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test("leaves the callback form alone rather than half-changing it", async () => {
    /*
     * `pg` supports `query(text, values, callback)`, which returns `undefined`
     * and reports errors to the callback. Wrapping it in an async function
     * returned a Promise instead and routed errors somewhere the caller was not
     * looking — two call styles behaving differently. Nothing here uses it; it
     * is delegated untouched rather than left as a trap.
     */
    const callback = vi.fn();
    const query = vi.fn().mockReturnValue(undefined);
    const pool = withReadRetry(poolOf(query));

    expect(pool.query("select 1", [], callback)).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
  });

  test("passes every argument through, both times", async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(dropped())
      .mockResolvedValueOnce({ rows: [] });
    const pool = withReadRetry(poolOf(query));

    await pool.query("select $1::int", [7]);

    expect(query).toHaveBeenNthCalledWith(1, "select $1::int", [7]);
    expect(query).toHaveBeenNthCalledWith(2, "select $1::int", [7]);
  });

  test("returns the same pool object, because Drizzle asks what it is", async () => {
    /*
     * `client instanceof Pool` decides whether a transaction gets a connection
     * of its own. An earlier attempt at a different problem wrapped the pool in
     * a Proxy, which answers no, and five transaction tests began rolling back
     * against a pool instead of a session. This patches the instance.
     */
    const pool = poolOf(vi.fn());

    expect(withReadRetry(pool)).toBe(pool);
  });
});
