import { describe, expect, test } from "vitest";

import {
  releaseScenarioRun,
  type ScenarioReleaseAnswer,
  scenarioReleaseAttempts,
  scenarioReleaseAttemptTimeoutMs,
  scenarioReleaseBackoffMs,
  scenarioReleaseRecoveryMs,
} from "../../tests/fixtures/scenario-release.js";

/**
 * Releasing a guarded scenario run across a development server that restarts
 * itself underneath the lane.
 *
 * `next dev` ends every request by comparing the heap against its own ceiling
 * and, when `used_heap_size > 0.8 * heap_size_limit`, calls `process.exit` so
 * its supervisor can start a fresh child — `getMemoryRestartStats` in
 * `next/dist/server/lib/utils.js`, reached from the `finally` of the request
 * listener in `start-server.js`. It is a designed behaviour, not a fault, and
 * on `ubuntu-latest` it fired three times inside one appearance lane (CI runs
 * 33207988275 and 33207990750, 2026-08-28).
 *
 * Every one of the four cases those two runs reported flaky failed in exactly
 * the same place — the release `DELETE` in the case's `finally` — and with a
 * transport failure rather than an answer: `connect ECONNREFUSED
 * 127.0.0.1:3100`, `read ECONNRESET`, and twice a hang that consumed the whole
 * 120s case budget. The case itself had already passed. Both runs produced the
 * identical four case identifiers in the identical order, so this is not
 * sampling noise on a slow host: it is a driver that assumes the server it
 * drives is continuously available for the whole lane.
 *
 * A restart also empties the register the hook keeps in the process, so the
 * next `DELETE` for a namespace opened before the restart is answered `404` —
 * truthfully. Retrying alone would therefore turn a flake into a hard failure
 * and still leak the rows. So the release retries only while the server gives
 * no answer at all, and, when a restarted server says it never opened the run,
 * removes that run's own recorded rows through the same reverse-key sweep the
 * hook would have used.
 */

type Attempt = ScenarioReleaseAnswer | "throw";

function scriptedRelease(answers: readonly Attempt[]) {
  const asked: number[] = [];
  const slept: number[] = [];
  const swept: number[] = [];

  return {
    asked,
    slept,
    swept,
    run: () =>
      releaseScenarioRun({
        del: async () => {
          const answer = answers[asked.length];
          asked.push(asked.length);
          if (answer === undefined || answer === "throw") {
            throw new Error("no scripted answer");
          }

          return answer;
        },
        sleep: async (ms: number) => {
          slept.push(ms);
        },
        sweep: async () => {
          swept.push(swept.length);
        },
      }),
  };
}

const answered = (status: number): ScenarioReleaseAnswer => ({
  kind: "answered",
  status,
});
const unreachable: ScenarioReleaseAnswer = { kind: "unreachable" };

describe("releasing a guarded scenario run", () => {
  test("asks once when the server answers", async () => {
    const scripted = scriptedRelease([answered(204)]);

    await scripted.run();

    expect({
      asked: scripted.asked.length,
      slept: scripted.slept,
      swept: scripted.swept.length,
    }).toEqual({ asked: 1, slept: [], swept: 0 });
  });

  test("waits out a restart rather than failing the case that paid for it", async () => {
    const scripted = scriptedRelease([unreachable, unreachable, answered(204)]);

    await scripted.run();

    // The case had already passed; only the release met the restart. Backing
    // off and asking again is the whole fix, and the wait is bounded by the
    // declared attempts rather than by the case budget.
    expect({
      asked: scripted.asked.length,
      slept: scripted.slept,
      swept: scripted.swept.length,
    }).toEqual({
      asked: 3,
      slept: [scenarioReleaseBackoffMs, scenarioReleaseBackoffMs],
      swept: 0,
    });
  });

  test("sweeps the run itself when the restarted server never opened it", async () => {
    const scripted = scriptedRelease([unreachable, answered(404)]);

    await scripted.run();

    // A restart takes the in-process register with it, so `404` is the honest
    // answer and the rows are still there. Leaving them would be the leak the
    // release exists to prevent.
    expect({
      asked: scripted.asked.length,
      swept: scripted.swept.length,
    }).toEqual({ asked: 2, swept: 1 });
  });

  test("sweeps the run when the register that held it is gone", async () => {
    const scripted = scriptedRelease([answered(410)]);

    await scripted.run();

    // The restart that took the register away happened while the case was
    // still driving its surface, so the release never met a transport failure
    // of its own: its first ask reaches a fresh process which answers, on the
    // register identity the run carries, that the register that opened this run
    // no longer exists. The run is gone and its rows are not, and this caller is
    // the last one holding their identifiers.
    expect({
      asked: scripted.asked.length,
      slept: scripted.slept,
      swept: scripted.swept.length,
    }).toEqual({ asked: 1, slept: [], swept: 1 });
  });

  test("refuses a 404 that no restart explains", async () => {
    const scripted = scriptedRelease([answered(404)]);

    // Without a transport failure first, `404` means the run being closed is
    // not the run that was opened. That is a defect in the driver, and sweeping
    // rows for it would hide the one thing the answer is telling us.
    await expect(scripted.run()).rejects.toThrow(
      "Acceptance scenario run could not be released: 404",
    );
    expect(scripted.swept.length).toBe(0);
  });

  test("refuses any other answer without retrying or sweeping", async () => {
    const scripted = scriptedRelease([answered(500), answered(204)]);

    await expect(scripted.run()).rejects.toThrow(
      "Acceptance scenario run could not be released: 500",
    );
    expect({
      asked: scripted.asked.length,
      swept: scripted.swept.length,
    }).toEqual({ asked: 1, swept: 0 });
  });

  test("gives up by name when the server never comes back", async () => {
    const scripted = scriptedRelease(
      Array.from({ length: scenarioReleaseAttempts + 2 }, () => unreachable),
    );

    // A server that stays down is not a restart, and a release that retried
    // forever would report it as the case running out of time — the exact
    // illegible failure the four flaky cases were.
    await expect(scripted.run()).rejects.toThrow(
      "Acceptance scenario run could not be released: unreachable",
    );
    expect({
      asked: scripted.asked.length,
      swept: scripted.swept.length,
    }).toEqual({ asked: scenarioReleaseAttempts, swept: 0 });
  });

  test("declares the recovery its own attempts can cost", async () => {
    // `playwright.config.ts` budgets one shard partly from this number, so it
    // has to be what the loop can actually spend rather than a second guess at
    // it. Both directions are planted: the identity below is the derivation,
    // and the bounds keep it a recovery rather than a second case budget.
    expect(scenarioReleaseRecoveryMs).toBe(
      scenarioReleaseAttempts * scenarioReleaseAttemptTimeoutMs +
        (scenarioReleaseAttempts - 1) * scenarioReleaseBackoffMs,
    );
    expect(scenarioReleaseAttempts).toBeGreaterThanOrEqual(2);
    expect(scenarioReleaseAttemptTimeoutMs).toBeGreaterThanOrEqual(5_000);
    expect(scenarioReleaseRecoveryMs).toBeLessThan(120_000);
  });
});
