import {
  magicLinkNotDelivered,
  restartTransportFailures,
  scenarioNavigationUnreachable,
} from "./scenario-navigation.js";

export const fixedE2EFailureMessages = {
  identityCleanup: "Foundation E2E identity cleanup failed",
  identityInspection: "Foundation E2E identity inspection failed",
  magicLinkVerification: "Foundation E2E magic-link verification failed",
  outboxLookup: "Foundation E2E outbox lookup failed",
  outboxReset: "Foundation E2E outbox reset failed",
} as const;

type FixedE2EFailureMessage =
  (typeof fixedE2EFailureMessages)[keyof typeof fixedE2EFailureMessages];

/**
 * The step sentences this wrapper is allowed to repeat.
 *
 * Derived from the messages above rather than listed beside them, so a step
 * added there is a step this can name, and a step renamed there is renamed
 * here in the same edit. The two that join them are the other sentences a
 * wrapped operation can fail with that this suite wrote and no caller
 * supplies: what the restart tolerance says when it has asked as often as it
 * may and the server has still answered nothing, and what the magic-link
 * acquisition says when every submission it may make went unanswered.
 */
export const fixedE2EFailureSteps: readonly string[] = Object.freeze([
  ...Object.values(fixedE2EFailureMessages),
  magicLinkNotDelivered,
  scenarioNavigationUnreachable,
]);

/**
 * The transport vocabulary, flattened, because a driver failure is a driver
 * failure whichever engine's lane produced it.
 */
const transportHeads: readonly string[] = Object.freeze(
  Object.values(restartTransportFailures).flat(),
);

/**
 * What one caught failure is allowed to have said.
 *
 * Every answer is a constant this module already held — the matched entry, not
 * a slice of what was caught — which is what makes the discriminator safe by
 * construction rather than by a filter someone has to keep correct. A message
 * that matches nothing says nothing.
 */
function recognised(text: string): string[] {
  return [
    ...fixedE2EFailureSteps.filter((step) => text.includes(step)),
    ...transportHeads
      .filter((head) => text.includes(head))
      .map((head) => head.trim()),
  ];
}

/**
 * The recognisable sentences along one failure's cause chain, outermost first.
 *
 * The chain is walked because the tolerance builds one: it reports its own
 * sentence and keeps the transport's underneath it, and the pair is what makes
 * a CI line readable — which loop gave up, and what the wire said while it did.
 * Errors already visited end the walk, so a chain that points back at itself
 * cannot loop.
 */
function discriminatorsOf(failure: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = failure;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    for (const step of recognised(current.message)) {
      if (!found.includes(step)) found.push(step);
    }
    current = current.cause;
  }

  return found;
}

/**
 * Run one step, and report a failure inside it without repeating what it held.
 *
 * The original error is discarded, cause and stack and all, because these
 * steps handle a magic-link URL that must never reach a public CI log. That
 * left a real failure as one fixed sentence and nothing else: a WebKit lane
 * reported `Foundation E2E magic-link verification failed` for a restart, and
 * the line said nothing about which of the three things inside that block —
 * the outbox lookup, the navigation to the link, or the address it landed on —
 * had failed, nor whether a server had answered at all.
 *
 * So the sentence keeps its discriminator. Both halves of the rule hold at
 * once because the discriminator is emitted from the closed set above rather
 * than copied out of the failure: what a caller threw can be recognised or
 * dropped, and there is no third thing it can do.
 */
export async function withFixedE2EFailure<T>(
  message: FixedE2EFailureMessage,
  operation: () => Promise<T>,
) {
  try {
    return await operation();
  } catch (failure) {
    const named = discriminatorsOf(failure).filter((step) => step !== message);

    throw new Error(
      named.length === 0 ? message : `${message}: ${named.join(" <- ")}`,
    );
  }
}
