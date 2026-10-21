import { createRequire } from "node:module";
import type * as Pg from "pg";
import { afterAll, afterEach, expect } from "vitest";

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
 * `packages/jobs`' integration project and worker-role lane. Loaded from
 * another workspace it patches the same `pg`: it requires `pg` from this
 * package, which is where every storage those suites build loads it from.
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
 * neither handed to a pg client); and a site no suite runs, which is why
 * `../one-query-at-a-time.integration.test.ts` also sweeps the source. Test
 * support only; nothing shipped imports it.
 */

/** A query issued on a client while others it was handed were in flight. */
export interface ConcurrentQuery {
  /** Vitest's current test name when it was issued, if it had one. */
  readonly test: string | undefined;
  /** The query issued, its text with whitespace collapsed. */
  readonly issued: string;
  /** The queries in flight on the same client at that moment. */
  readonly inFlight: readonly string[];
}

interface GuardState {
  readonly recorded: ConcurrentQuery[];
  currentTest: () => string | undefined;
}

/*
 * Held on the global object, not in this module: Vitest evaluates a setup
 * file again for each test file, while `pg`, loaded through `require`, is
 * evaluated once a process and patched once. Were two test files to run in
 * one worker process, module state would leave the patch writing to the
 * first file's list after that file had ended.
 */
const STATE = Symbol.for("requestport.db.test.oneQueryAtATime");
const PATCHED = Symbol.for("requestport.db.test.oneQueryAtATime.patched");

function guardState(): GuardState {
  const holder = globalThis as { [STATE]?: GuardState };

  holder[STATE] ??= { recorded: [], currentTest: () => undefined };
  return holder[STATE];
}

function textOf(config: unknown): string {
  const text =
    typeof config === "string"
      ? config
      : typeof config === "object" &&
          config !== null &&
          typeof (config as { text?: unknown }).text === "string"
        ? (config as { text: string }).text
        : String(config);

  return text.replace(/\s+/gu, " ").trim();
}

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
    const state = guardState();
    const running = inFlight.get(this) ?? new Map<number, string>();
    const issued = textOf(args[0]);

    inFlight.set(this, running);
    if (running.size > 0) {
      state.recorded.push({
        test: state.currentTest(),
        issued,
        inFlight: [...running.values()],
      });
    }

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

/** Every query recorded since the last call, which it clears. */
export function takeConcurrentQueries(): ConcurrentQuery[] {
  const { recorded } = guardState();

  return recorded.splice(0, recorded.length);
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
