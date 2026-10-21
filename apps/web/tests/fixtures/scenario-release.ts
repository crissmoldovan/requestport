/**
 * Releasing one guarded scenario run across a server that restarts itself.
 *
 * `next dev` ends every request by comparing the heap against its own ceiling
 * and, when `used_heap_size > 0.8 * heap_size_limit`, calls `process.exit` so
 * its supervisor can start a fresh child. That is `getMemoryRestartStats` in
 * `next/dist/server/lib/utils.js`, reached from the `finally` of the request
 * listener in `start-server.js`; it is designed behaviour, and on
 * `ubuntu-latest` it fired three times inside a single appearance lane in CI
 * runs 33207988275 and 33207990750.
 *
 * The four cases both of those runs reported flaky failed in one place — this
 * release, in the case's own `finally` — and with a transport failure rather
 * than an answer: `connect ECONNREFUSED 127.0.0.1:3100`, `read ECONNRESET`, and
 * twice a hang that ate the whole 120s case budget. Each case had already
 * passed. The two runs named the identical four cases in the identical order,
 * so the instability is not the host being slow: the driver assumed the server
 * it drives stays up for the whole lane, and it does not.
 *
 * A restart also empties the register the hook keeps in the process, so a
 * `DELETE` for a namespace opened before the restart is answered `404`, and
 * truthfully. Retrying alone would turn today's flake into a hard failure and
 * still leave the rows behind. So this module separates the two answers: it
 * retries only while the server gives no answer at all, and when a restarted
 * server says it never opened the run it removes that run's own recorded rows
 * through the sweep the hook would have run.
 *
 * The ports are injected because the decision is the thing worth proving, and a
 * test that needed a browser context and a database to observe it would be
 * testing those instead.
 */

/** What one release attempt got back. */
export type ScenarioReleaseAnswer =
  | Readonly<{ kind: "answered"; failure?: string; status: number }>
  /** No HTTP answer at all: refused, reset, or no reply inside the attempt. */
  | Readonly<{ kind: "unreachable" }>;

/**
 * How long one attempt may wait for an answer.
 *
 * Far above what a loopback `DELETE` costs when the server is up — the
 * measured cases answer in well under a second — and far below the 120s case
 * budget, so a restart is absorbed by the retry rather than reported as the
 * case running out of time with no line and no locator.
 */
export const scenarioReleaseAttemptTimeoutMs = 15_000;

/** How many attempts one release may make. */
export const scenarioReleaseAttempts = 4;

/** How long to wait between two attempts. */
export const scenarioReleaseBackoffMs = 1_000;

/**
 * What the hook answers when the register that opened a run is gone.
 *
 * `410` rather than `404`, because the two answers want opposite things and
 * used to share one. A restart of the development server empties the in-process
 * register, so every release of a run opened before it was answered "nothing
 * opened that" — truthfully, and identically to a driver closing a run that was
 * never opened at all. The first leaves seeded rows only this caller can still
 * address; the second is a defect. The hook now says which, and this is the
 * answer that means the first.
 */
export const scenarioReleaseRegisterGone = 410;

/**
 * The wall clock one restart may cost a release.
 *
 * Derived from the loop rather than asserted beside it, because
 * `playwright.config.ts` budgets a shard partly from this number and a second
 * hand-written copy is how the two would come to disagree.
 */
export const scenarioReleaseRecoveryMs =
  scenarioReleaseAttempts * scenarioReleaseAttemptTimeoutMs +
  (scenarioReleaseAttempts - 1) * scenarioReleaseBackoffMs;

export type ScenarioReleasePorts = Readonly<{
  /** Ask the hook to release the run. Never throws: a failure is an answer. */
  del: () => Promise<ScenarioReleaseAnswer>;
  /** Remove the run's own recorded rows without the hook. */
  sweep: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}>;

/**
 * Release a run, tolerating a restart of the server that holds it.
 *
 * Anything other than "the server did not answer" ends the loop: a `404` that
 * no transport failure explains means the run being closed is not the run that
 * was opened, and that is a defect this must report rather than sweep away.
 */
export async function releaseScenarioRun({
  del,
  sleep,
  sweep,
}: ScenarioReleasePorts): Promise<void> {
  let restarted = false;

  for (let attempt = 1; attempt <= scenarioReleaseAttempts; attempt += 1) {
    const answer = await del();

    if (answer.kind === "answered") {
      if (answer.status === 204) return;
      if (answer.status === scenarioReleaseRegisterGone) {
        // The hook itself says the register that opened this run is not the one
        // answering: the process that held it exited, taking the run with it.
        // That is a restart the release never had to witness — it is the far
        // more common shape, because the restart usually happens while the case
        // is still driving its surface, minutes before the release asks
        // anything. The rows the run created are still there, and this is the
        // only caller that still has their identifiers.
        await sweep();
        return;
      }
      if (answer.status === 404 && restarted) {
        // The same conclusion reached the other way: this release watched the
        // server go away and come back, and the server that came back has never
        // heard of the run. Kept beside the answer above because it needs
        // nothing from the hook — a server too old to name its register, or one
        // that restarts between two attempts of this very loop, still ends here.
        await sweep();
        return;
      }

      // The hook's own sentence when it sent one. It is composed from a closed
      // vocabulary and, for a failed cleanup, names the table it failed on —
      // which is the difference between a lane that says every release failed
      // and one that says which rows could not be removed.
      throw new Error(
        [
          "Acceptance scenario run could not be released",
          String(answer.status),
          ...(answer.failure === undefined ? [] : [answer.failure]),
        ].join(": "),
      );
    }

    restarted = true;
    if (attempt < scenarioReleaseAttempts)
      await sleep(scenarioReleaseBackoffMs);
  }

  // A server that never comes back is not a restart. Say so, rather than
  // letting the case report that it ran out of time.
  throw new Error("Acceptance scenario run could not be released: unreachable");
}
