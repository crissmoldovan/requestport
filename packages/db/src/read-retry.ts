import type { DatabaseDriver } from "./client.js";
import { isHostedDriver, isHostedServerError } from "./hosted-driver.js";

/**
 * Asking a dropped read once more.
 *
 * Measured on the local stack: a connection dies abnormally mid-render every so
 * often, and the read on it fails the render. In the minute one of those
 * failures happened the proxy logged a single abnormal close against fifteen
 * normal ones, and PostgreSQL logged no resets, no terminations and no "too
 * many clients" — nothing is refused at the database end, a socket simply dies.
 *
 * This is not a test workaround, which is why it lives here rather than in a
 * fixture. The hosted driver (`hosted-driver.ts`, where the tree has one)
 * speaks WebSocket to its database over the public internet in production,
 * where a connection is at least as likely to die as it is over a loopback
 * proxy; today that fails a person's page load exactly as it failed the
 * lane's.
 */

/**
 * What a socket says when it goes.
 *
 * Read only after the class check below has ruled out a server answer, because
 * these words appear in server errors too: a relation named `WebSocket_events`
 * puts "WebSocket" in a `42P01`, and re-sending a query the server has already
 * refused is the failure this ordering prevents.
 */
const socketFailure =
  /terminated|socket hang up|ECONNRESET|EPIPE|ECONNREFUSED|WebSocket|closed before|connection closed/iu;

/**
 * SQLSTATE class 08 — "connection exception", the server saying the connection
 * itself failed rather than the query.
 *
 * On the hosted database this is the common shape: a compute scaling from
 * zero or moving answers `08006`, which arrives as the driver's server error
 * (`isHostedServerError`). Refusing every server error left the production
 * failure this exists for uncovered.
 *
 * Class 53 (`53300`, too many clients) and `57P01` (administrator shutdown)
 * are deliberately not here. Both read as connection failures and asking again
 * immediately makes both worse.
 */
const connectionClass = /^08/u;

/**
 * Whether the connection died, as opposed to the server refusing the query.
 *
 * The discriminator is the driver's server-error class (`isHostedServerError`
 * in `hosted-driver.ts`; in the private tree, the driver's `DatabaseError`):
 * the driver gives that class to a failure the server answered and never to a
 * dead socket. Matching the *shape* of a SQLSTATE instead was wrong twice
 * over — `EPIPE` is five capitals, so a genuine socket failure was read as a
 * query the server had answered.
 *
 * The first branch is the one that matters, and it is the one the first version
 * of this file missed. Drizzle's `Failed query: …` with an `ErrorEvent` in its
 * `cause` is built *above* the pool; what the patched `query` catches is the
 * driver's raw rejection, and for a WebSocket error that is the event itself —
 * an `Event`, not an `Error`. An `instanceof Error` gate made this inert for
 * the one shape it was written for. The `cause` branch stays for callers that
 * hand back Drizzle's wrapper.
 *
 * Anything else is not a connection failure. The default is to report what
 * happened rather than repeat something nobody has characterised.
 */
export function isConnectionFailure(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;

  if (isHostedServerError(error)) {
    const code = (error as { code?: unknown }).code;

    return typeof code === "string" && connectionClass.test(code);
  }

  if ((error as { type?: unknown }).type === "error") return true;

  const cause = (error as { cause?: unknown }).cause;

  if (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { type?: unknown }).type === "error"
  ) {
    return true;
  }

  return error instanceof Error && socketFailure.test(error.message);
}

/**
 * Statements that change something, including the ones that hide it.
 *
 * `into` is here because `select … into` is `create table as`. The DDL verbs
 * are here because a second statement can carry them. The functions are here
 * because they change something from inside a plain select, and they are
 * matched by prefix rather than by name: `\bpg_advisory_lock\b` cannot match
 * `pg_advisory_xact_lock`, since `_` is a word character and there is no
 * boundary — and `pg_advisory_xact_lock` is the spelling this repository
 * actually uses. The list was one spelling wide in the family the code depends
 * on.
 */
const writes =
  /\b(?:insert|update|delete|merge|truncate|drop|create|alter|grant|revoke|copy|call|do|reindex|refresh|vacuum|analyze|lock|into|nextval|setval|set_config|txid_current|setseed|dblink\w*|lo_\w+|query_to_xml|pg_advisory\w*|pg_try_advisory\w*|pg_notify|pg_logical_emit_message|pg_terminate_backend|pg_cancel_backend|pg_stat_reset\w*|pg_reload_conf)\b/iu;

/** A read that holds a lock, which belongs to a transaction rather than here. */
const locking = /\bfor\s+(?:no\s+key\s+)?(?:update|share|key\s+share)\b/iu;

/** A second statement hiding behind the first. */
const another = /;\s*\S/u;

/**
 * Whether asking again is safe.
 *
 * Conservative on purpose: declining a safe retry costs one honest failure, and
 * allowing a wrong one duplicates a write. So this admits only a statement that
 * begins `select`, carries no writing or DDL keyword anywhere in it, holds no
 * lock, and is one statement rather than several — `select 1; truncate …`
 * passed every earlier check by starting with the right word.
 *
 * **The residual, stated rather than implied.** A `select` that calls a
 * VOLATILE function — `select claim_next_job($1)` — writes, and nothing here
 * can tell: the write is inside the function body, which this never sees. No
 * such call exists in this repository outside a transaction today, and a
 * reviewer of a new one should know this retry is behind it. That is the limit
 * of a guard that reads SQL text, and it is why the guard is the second
 * condition rather than the only one.
 *
 * Transactions never reach here at all: Drizzle checks a connection out of the
 * pool for those, and only the pool's own `query` is patched.
 */
export function isRetryableRead(statement: unknown): boolean {
  const text =
    typeof statement === "string"
      ? statement
      : typeof statement === "object" &&
          statement !== null &&
          typeof (statement as { text?: unknown }).text === "string"
        ? (statement as { text: string }).text
        : undefined;

  if (text === undefined) return false;
  if (!/^\s*select\b/iu.test(text)) return false;
  if (another.test(text)) return false;
  if (writes.test(text)) return false;

  return !locking.test(text);
}

/**
 * Patch the pool's `query` so a dropped read is asked once more.
 *
 * The instance is patched and returned, never wrapped. Drizzle asks
 * `client instanceof Pool` to decide whether a transaction gets a connection of
 * its own, and a `Proxy` answers no — the private tree's `hosted-driver.ts`
 * records five transaction tests rolling back against a pool instead of a
 * session when that was tried for a different reason.
 *
 * The callback form is delegated untouched. `pg` supports
 * `query(text, values, callback)`, which returns `undefined` and reports errors
 * to the callback; making it async returned a Promise instead and sent errors
 * where the caller was not looking. Nothing here uses it, so it is left exactly
 * as it was rather than left as a trap.
 *
 * Once. A connection that is gone stays gone, and repeating past one attempt
 * turns a dropped socket into a stall. The pool opens a *new* connection for
 * the second attempt — the broken client is released with its error and removed
 * before the promise rejects — so no delay is needed for a socket that died
 * mid-query.
 *
 * It says when it heals something. This sits one layer below the detector
 * written to surface exactly these drops, and the lane's own record argues that
 * a silent retry "would have hidden every one of these while leaving them in
 * the stack". A healed run and a healthy one must not look the same.
 */
export function withReadRetry<
  P extends { query: (...args: never[]) => unknown },
>(pool: P): P {
  const original = pool.query.bind(pool) as (
    ...args: readonly unknown[]
  ) => unknown;

  Object.defineProperty(pool, "query", {
    configurable: true,
    value: (...args: readonly unknown[]) => {
      if (typeof args.at(-1) === "function") return original(...args);

      return (async () => {
        try {
          return await (original(...args) as Promise<unknown>);
        } catch (error) {
          if (!isConnectionFailure(error)) throw error;
          if (!isRetryableRead(args[0])) throw error;

          console.warn(
            "Database connection dropped mid-read; asking once more.",
          );

          return await (original(...args) as Promise<unknown>);
        }
      })();
    },
    writable: true,
  });

  return pool;
}

/**
 * Whether a storage on this driver gets the retry (contract §3.8).
 *
 * The hosted driver: yes unless asked not to, as it always has. pg: never, and
 * asking is refused rather than ignored. `isConnectionFailure` separates a
 * server's answer from a dead socket by the hosted driver's server-error
 * class, and pg's comes from `pg-protocol`, a different class — so under pg a
 * server error whose message names a socket would be re-sent, and a real
 * `08006` would not (contract §2.5, probed both ways). It stays off for pg
 * until the classification reads the SQLSTATE the error carries rather than
 * its class.
 * PGlite: never either — it runs in this process, so there is no connection
 * to drop, and asking is refused the same way.
 */
export function readRetryFor(
  driver: DatabaseDriver,
  requested: boolean | undefined,
): boolean {
  if (isHostedDriver(driver)) return requested ?? true;

  if (requested === true) {
    throw new Error(
      driver === "pg"
        ? "The read retry cannot be turned on for the pg driver: it cannot " +
            "yet tell a pg server error from a dropped connection."
        : "The read retry cannot be turned on for PGlite: it runs in this " +
            "process, so there is no connection to drop.",
    );
  }
  return false;
}
