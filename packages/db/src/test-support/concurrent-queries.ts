/*
 * What the one-query-at-a-time guard records (Plan 13, X24), where both the
 * guard (`one-query-at-a-time.ts`, the Vitest setup that patches `pg`) and
 * `queueQueriesOn` (`queue-queries.ts`), which records for the queries it
 * queues, reach it. Importing this patches nothing and registers no hook.
 * Test support only; nothing shipped imports it.
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
 * Held on the global object, not in a module: Vitest evaluates a setup file
 * again for each test file, while `pg`, loaded through `require`, is
 * evaluated once a process and patched once. Were two test files to run in
 * one worker process, module state would leave the patch writing to the
 * first file's list after that file had ended.
 */
const STATE = Symbol.for("requestport.db.test.oneQueryAtATime");

/** The records, and how the current test's name is read (the guard sets it). */
export function guardState(): GuardState {
  const holder = globalThis as { [STATE]?: GuardState };

  holder[STATE] ??= { recorded: [], currentTest: () => undefined };
  return holder[STATE];
}

/** A query's text, from its string or its configuration's `text`, whitespace collapsed. */
export function queryText(config: unknown): string {
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

/** Records `issued`, issued while `inFlight` were, under the current test. */
export function recordConcurrentQuery(
  issued: string,
  inFlight: readonly string[],
): void {
  const state = guardState();

  state.recorded.push({
    test: state.currentTest(),
    issued,
    inFlight: [...inFlight],
  });
}

/** Every query recorded since the last call, which it clears. */
export function takeConcurrentQueries(): ConcurrentQuery[] {
  const { recorded } = guardState();

  return recorded.splice(0, recorded.length);
}
