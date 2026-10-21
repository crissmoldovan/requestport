import { describe, expect, test } from "vitest";

import {
  acquireMagicLink,
  magicLinkDeliveryRecoveryMs,
  magicLinkNotDelivered,
  magicLinkPollBudgetMs,
  magicLinkPollIntervalMs,
  magicLinkSubmissions,
  restartTransportFailures,
  scenarioNavigationAttemptTimeoutMs,
  scenarioNavigationRecoveryMs,
  scenarioNavigationUnreachable,
} from "../../tests/fixtures/scenario-navigation.js";

/**
 * Why waiting longer is not the fix, and asking again is.
 *
 * The outbox this poll reads is a `Map` on the serving process's own
 * `globalThis`, and `next dev` restarts itself by exiting so its supervisor can
 * start a fresh child. A link captured before that restart is therefore not
 * late — it is gone, and no budget reaches it. What reaches it is a second
 * submission, to the child that is now serving.
 *
 * Driven by scripted answers rather than by a browser, because the decision is
 * the thing worth proving and a rule that only ever runs against a real server
 * is a rule nobody can prove says anything.
 */
type Answer = string | "empty" | "unreachable" | "broken";

function scriptedDelivery(answers: readonly Answer[]) {
  const asked: string[] = [];
  const slept: number[] = [];
  const submitted: number[] = [];
  let clock = 0;

  return {
    asked,
    slept,
    submitted,
    run: () =>
      acquireMagicLink({
        lookup: async () => {
          const next = answers[asked.length];
          asked.push(next ?? "exhausted");
          if (next === undefined) throw new Error("no scripted answer");
          if (next === "empty") return null;
          if (next === "unreachable") {
            clock += scenarioNavigationRecoveryMs;
            throw new Error(scenarioNavigationUnreachable, {
              cause: new Error(restartTransportFailures.driver[1] ?? ""),
            });
          }
          if (next === "broken") throw new Error("Invalid outbox response");

          return next;
        },
        now: () => clock,
        sleep: async (ms: number) => {
          slept.push(ms);
          clock += ms;
        },
        submit: async () => {
          submitted.push(clock);
        },
      }),
  };
}

/** Enough empty answers to spend one submission's whole poll budget. */
const emptyPoll = Array.from(
  { length: Math.ceil(magicLinkPollBudgetMs / magicLinkPollIntervalMs) + 1 },
  (): Answer => "empty",
);

describe("acquiring a magic link across a server that restarts itself", () => {
  test("returns the link the submission it made delivered", async () => {
    const scripted = scriptedDelivery(["empty", "https://example.invalid/x"]);

    expect(await scripted.run()).toBe("https://example.invalid/x");
    expect(scripted.submitted.length).toBe(1);
    expect(scripted.slept).toEqual([magicLinkPollIntervalMs]);
  });

  test("asks for a new link when the outbox that held one is gone", async () => {
    // The restart shape this exists for. The server answers, and answers
    // truthfully: it has no link, because the process that captured one exited.
    // Waiting is the one thing that cannot help.
    const scripted = scriptedDelivery([
      ...emptyPoll,
      "https://example.invalid/second",
    ]);

    expect(await scripted.run()).toBe("https://example.invalid/second");
    expect(scripted.submitted.length).toBe(2);
  });

  test("asks for a new link when the server answered the lookup nothing", async () => {
    // The other shape, and the one the CI lane met: the lookup spent its own
    // whole tolerance and the server said nothing at all. The outbox that took
    // the first submission is gone with the process, so the poll does not wait
    // out its budget before asking again.
    const scripted = scriptedDelivery([
      "unreachable",
      "https://example.invalid/second",
    ]);

    expect(await scripted.run()).toBe("https://example.invalid/second");
    expect(scripted.submitted.length).toBe(2);
    expect(scripted.slept).toEqual([]);
  });

  test("reports a lookup failure no restart explains, unretried", async () => {
    // Planted the other way, because a poll that asked again for everything
    // would satisfy the cases above and would hide a defect in the outbox
    // route behind a second submission and a slower failure.
    const scripted = scriptedDelivery(["broken", "https://example.invalid/x"]);

    await expect(scripted.run()).rejects.toThrow("Invalid outbox response");
    expect(scripted.submitted.length).toBe(1);
    expect(scripted.asked.length).toBe(1);
  });

  test("gives up by name, and says what the wire said while it did", async () => {
    const scripted = scriptedDelivery(
      Array.from({ length: magicLinkSubmissions }, (): Answer => "unreachable"),
    );
    const failure = await scripted.run().then(
      () => null,
      (error: unknown) => error as Error,
    );

    expect(failure?.message).toBe(magicLinkNotDelivered);
    expect(scripted.submitted.length).toBe(magicLinkSubmissions);

    // The last thing the wire said is kept as a cause rather than folded into
    // the message: the wrapper above this reads a cause chain for the
    // sentences it already holds, and this is where the transport's own is.
    expect((failure?.cause as Error | undefined)?.message).toBe(
      scenarioNavigationUnreachable,
    );
  });

  test("declares the recovery its own submissions can cost", async () => {
    // One submission can spend the navigation tolerance getting the sign-in
    // form answered, and then the poll budget waiting for what it asked for.
    // Both terms are bounds other modules declare, so this cannot come to
    // disagree with what the loop actually spends.
    expect(magicLinkDeliveryRecoveryMs).toBe(
      magicLinkSubmissions *
        (scenarioNavigationRecoveryMs + magicLinkPollBudgetMs),
    );
    expect(magicLinkPollBudgetMs).toBe(scenarioNavigationAttemptTimeoutMs);
    expect(magicLinkPollIntervalMs).toBeLessThan(magicLinkPollBudgetMs);

    // Fewer than two submissions is a poll that cannot survive the restart
    // this module exists for: the first submission is the one the restart
    // destroys.
    expect(magicLinkSubmissions).toBeGreaterThanOrEqual(2);
  });
});
