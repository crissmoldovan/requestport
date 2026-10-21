import { describe, expect, test } from "vitest";

import {
  fixedE2EFailureMessages,
  fixedE2EFailureSteps,
  withFixedE2EFailure,
} from "../../tests/fixtures/fixed-failure.js";
import {
  restartTransportFailures,
  scenarioNavigationUnreachable,
} from "../../tests/fixtures/scenario-navigation.js";

/** What one wrapped operation reported, or nothing if it did not fail. */
async function failureOf(
  message: (typeof fixedE2EFailureMessages)[keyof typeof fixedE2EFailureMessages],
  thrown: unknown,
): Promise<Error> {
  const caught = await withFixedE2EFailure(message, async () => {
    throw thrown;
  }).then(
    () => null,
    (error: unknown) => error,
  );

  expect(caught).toBeInstanceOf(Error);

  return caught as Error;
}

describe("E2E credential failure redaction", () => {
  test("discards the original error and exposes only the fixed message", async () => {
    const credential = "credential-bearing-url-and-header-sentinel";

    const result = await withFixedE2EFailure(
      fixedE2EFailureMessages.magicLinkVerification,
      async () => {
        throw new Error(credential);
      },
    ).then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );

    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe(
      fixedE2EFailureMessages.magicLinkVerification,
    );
    expect((result.error as Error).cause).toBeUndefined();
    expect(String(result.error)).not.toContain(credential);
    expect((result.error as Error).stack).not.toContain(credential);
  });

  test("names the step that failed, and repeats no credential to do it", async () => {
    // The failure this closes. A restart inside the magic-link sign-in was
    // reported as the outer step alone, so CI showed one fixed sentence and
    // nothing about which of the three things inside it had failed — the
    // outbox lookup, the navigation to the link, or the address it landed on.
    // The inner step is a sentence this suite wrote, so repeating it leaks
    // nothing and is the whole difference between a diagnosis and a shrug.
    const failure = await failureOf(
      fixedE2EFailureMessages.magicLinkVerification,
      new Error(fixedE2EFailureMessages.outboxLookup),
    );

    expect(failure.message).toBe(
      `${fixedE2EFailureMessages.magicLinkVerification}: ${fixedE2EFailureMessages.outboxLookup}`,
    );
    expect(failure.cause).toBeUndefined();
  });

  test("names the transport that answered, by the head this suite knows", async () => {
    // The tail of one of these sentences is an address and a C library's word
    // for an errno, and a magic link is a URL — so only the head is repeated,
    // and the head is emitted from the constant rather than sliced out of what
    // was caught. Nothing a caller threw can reach the message that way.
    const credential = "credential-bearing-url-and-header-sentinel";
    const head = restartTransportFailures.webkit[1] ?? "";
    const failure = await failureOf(
      fixedE2EFailureMessages.outboxLookup,
      new Error(`${head}Connection reset by peer ${credential}`),
    );

    expect(failure.message).toBe(
      `${fixedE2EFailureMessages.outboxLookup}: ${head.trim()}`,
    );
    expect(String(failure)).not.toContain(credential);
    expect(failure.stack).not.toContain(credential);
  });

  test("follows a cause chain the tolerance built, and says both halves", async () => {
    // `askThroughRestarts` reports its own sentence and keeps the transport's
    // underneath it as a cause. Both are sentences this suite owns, and the
    // pair is what makes a CI line readable: which loop gave up, and what the
    // wire said while it did.
    const credential = "credential-bearing-url-and-header-sentinel";
    const head = restartTransportFailures.chromium[1] ?? "";
    const failure = await failureOf(
      fixedE2EFailureMessages.outboxLookup,
      new Error(scenarioNavigationUnreachable, {
        cause: new Error(`page.goto: net::${head} at ${credential}`),
      }),
    );

    expect(failure.message).toBe(
      `${fixedE2EFailureMessages.outboxLookup}: ${scenarioNavigationUnreachable} <- ${head}`,
    );
    expect(String(failure)).not.toContain(credential);
  });

  test("repeats nothing it does not already hold as a constant", async () => {
    // The rule that makes the two tests above safe, planted directly: a
    // discriminator is emitted from the constant it matched, so a sentence
    // carrying a credential can only ever be recognised or dropped, never
    // repeated.
    const credential = "credential-bearing-url-and-header-sentinel";
    const silent = await failureOf(
      fixedE2EFailureMessages.identityCleanup,
      new Error(`${credential} ${credential}`),
    );

    expect(silent.message).toBe(fixedE2EFailureMessages.identityCleanup);

    const known = new Set([
      ...fixedE2EFailureSteps,
      ...Object.values(restartTransportFailures)
        .flat()
        .map((head) => head.trim()),
    ]);
    const spoken = await failureOf(
      fixedE2EFailureMessages.identityInspection,
      new Error(`${scenarioNavigationUnreachable} ${credential}`, {
        cause: new Error(`${restartTransportFailures.driver[0]} ${credential}`),
      }),
    );
    const said = spoken.message
      .slice(fixedE2EFailureMessages.identityInspection.length + ": ".length)
      .split(" <- ");

    expect(said.length).toBeGreaterThan(0);
    expect(said.filter((step) => !known.has(step))).toEqual([]);
    expect(String(spoken)).not.toContain(credential);
  });
});
