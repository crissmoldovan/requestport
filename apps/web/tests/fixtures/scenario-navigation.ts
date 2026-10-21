import type { Page } from "@playwright/test";

/**
 * Navigating a server that restarts itself mid-request.
 *
 * The mechanism `scenario-release.ts` documents, met on the way in rather than
 * on the way out. `next dev` ends every request by comparing the heap against
 * its own ceiling and, when the used size crosses the share it watches, calls
 * `process.exit` so its supervisor can start a fresh child. The release path
 * was taught to survive that; a navigation racing the same restart was not,
 * and in CI run 33259821308 an appearance case reported
 * `net::ERR_CONNECTION_RESET` against the surface it was asked to drive.
 *
 * A navigation the transport never delivered did nothing at all, so asking
 * again is safe and is the whole fix. A navigation that failed for any other
 * reason is the page's own answer and is re-thrown untouched, because retrying
 * it would turn a defect in the page into a slower defect in the page and hide
 * the attempt that reported it.
 *
 * A restart does not always answer. The socket the supervisor holds keeps
 * accepting while no child is serving, so the request in flight is neither
 * delivered nor refused — it is simply never answered, and that is the shape
 * both restarts took in CI run 33315836689. Navigation carried no budget of
 * its own there, so the waiting ended only when the case did: the ordinary
 * case that met the first restart spent its whole budget and was reported as
 * having run out of time, and the case that met the second declares a budget
 * of its own and sat inside it until the lane's ceiling expired, naming
 * neither the case nor the server.
 *
 * So an attempt is bounded, and the bound is what tells the two apart. A
 * request the server is still working on is answered inside it; a server that
 * is not there answers nothing, the attempt is abandoned, and the loop asks
 * again. Abandoning is safe for the same reason retrying is: a navigation is a
 * request for a document and nothing else, and a compile the abandoned attempt
 * started goes on in the server, so the attempt after it arrives at a route
 * that is further along than the one before it found.
 *
 * What a restart costs here is therefore both terms — the attempts that are
 * never answered and the backing off between them — and that total is what
 * `playwright.config.ts` floors a shard's restart charge by.
 */

/**
 * The page methods that put a request on the wire.
 *
 * Every one of them asks the development server for a document, so every one
 * of them can be answered by the transport instead of by the server. The
 * tolerance used to cover the first navigation a case makes and nothing else,
 * which left every reload in this tree exposed to the reset the loop exists to
 * absorb — and a reload is the *more* exposed of the two, because a case only
 * reloads after it has already spent its setup.
 *
 * Exported because it is a claim about this tree rather than a detail of the
 * loop: `scenario-navigation.test.ts` requires every navigation the specs and
 * the fixtures make to be one of these, so a page method the tolerance does
 * not cover fails a test instead of failing a case.
 */
export const scenarioNavigationPageMethods = ["goto", "reload"] as const;

/**
 * How long one attempt may wait for the server to answer.
 *
 * The same shape `scenario-release.ts` gives a release, for the same reason: a
 * call that is never answered has to end in something the loop can read. Well
 * above what a navigation to this development server costs when the server is
 * up — including the first request for a route, which the server compiles
 * before it replies — and well below the budget of the shortest case in this
 * suite, so a server that is gone is reported as a server that is gone rather
 * than as the journey taking too long.
 *
 * It is installed on the page rather than passed at each call, because the
 * page methods this module patches do not take their options in the same
 * position and a bound that had to be threaded through each signature is a
 * bound the next method added here would miss.
 */
export const scenarioNavigationAttemptTimeoutMs = 30_000;

/**
 * How many times one navigation may be asked for.
 *
 * Fewer than the loop asked for before it bounded an attempt. Waiting used to
 * be the backing off alone, so attempts were cheap and more of them bought
 * more tolerance; now an unanswered attempt spends the bound above, and the
 * whole loop still has to end inside the budget of the case it runs in.
 */
export const scenarioNavigationAttempts = 3;

/** How long to wait between two attempts. */
export const scenarioNavigationBackoffMs = 5_000;

/**
 * The wall clock this loop can add to one navigation.
 *
 * Derived from the loop rather than asserted beside it, so the bound and the
 * behaviour cannot come to disagree. It is every attempt spending its bound
 * unanswered, plus the backing off between them: the worst a restart can cost
 * a navigation before the loop gives up and says so.
 */
export const scenarioNavigationRecoveryMs =
  scenarioNavigationAttempts * scenarioNavigationAttemptTimeoutMs +
  (scenarioNavigationAttempts - 1) * scenarioNavigationBackoffMs;

/** What a navigation reports when it never reached a server at all. */
export const scenarioNavigationUnreachable =
  "Acceptance navigation could not reach the server";

/**
 * The transport failures a restarting server produces, in the words of
 * whatever reported them.
 *
 * Every one of them means the request was not delivered: the socket was
 * refused, reset, or closed before a reply. A navigation that *was* delivered
 * and then failed — a timeout, a rejected assertion, a closed page — is not
 * here, and is exactly what this loop must not swallow.
 *
 * Keyed by what produced the sentence rather than kept as one list, because
 * one list is what let a whole engine go missing. Every entry it held was
 * Chromium's spelling, written while no WebKit lane had ever run, and nothing
 * recorded that the vocabulary belonged to an engine — so the tolerance proven
 * on Chromium was blind on WebKit, and the first restart a WebKit lane met
 * failed the case it landed on. `scripts/playwright-config.test.mjs` now
 * requires a vocabulary here for every engine the configuration declares a
 * project for, so an engine cannot join the matrix with nothing to say.
 *
 * `driver` is not an engine. A request made through Playwright's own request
 * context is made by Node in the driver process, so it fails in Node's words
 * whichever browser the lane is driving.
 */
export const restartTransportFailures = Object.freeze({
  /**
   * Chromium names a network error out of a fixed enumeration, so a token is
   * the whole of what there is to recognise.
   */
  chromium: Object.freeze([
    "ERR_CONNECTION_REFUSED",
    "ERR_CONNECTION_RESET",
    "ERR_CONNECTION_CLOSED",
    "ERR_CONNECTION_ABORTED",
    "ERR_EMPTY_RESPONSE",
    "ERR_SOCKET_NOT_CONNECTED",
  ]),
  driver: Object.freeze(["ECONNREFUSED", "ECONNRESET", "socket hang up"]),
  /**
   * WebKit has no such enumeration. On Linux it reports the sentence the stack
   * beneath it built, so the entries are the heads of those sentences and the
   * reason each is a head is that the tail is a variable.
   *
   * Most of them come from the socket layer the shipped build links, whose
   * strings are `Could not connect to %s: %s`, `Error receiving data: %s` and
   * `Error sending data: %s` — an address and the C library's word for the
   * errno. Matching a whole sentence would recognise the errno that happened to
   * be reproduced and miss every sibling of it, which is the way this list went
   * wrong the first time; matching the head recognises the call that failed,
   * which is what makes the request undelivered.
   *
   * The remaining entry is the HTTP library's own, for a peer that closed
   * before the message was complete — and it is the sentence a development
   * server produces when its supervisor kills the child that was serving, so it
   * is the one this suite meets most.
   *
   * A name that does not resolve is deliberately not here. It has a head of its
   * own, it is not a server restarting, and asking again would spend this
   * loop's whole budget on an address that will never exist.
   */
  webkit: Object.freeze([
    "Could not connect to ",
    "Error receiving data: ",
    "Error sending data: ",
    "Connection terminated unexpectedly",
  ]),
});

export function isRestartTransportFailure(text: string): boolean {
  return Object.values(restartTransportFailures).some((vocabulary) =>
    vocabulary.some((failure) => text.includes(failure)),
  );
}

/**
 * The bound above, as the page reports having reached it.
 *
 * Built from the constant rather than written beside it, so the text this
 * recognises is the text the bound this module installs actually produces.
 */
const attemptBoundReached = new RegExp(
  String.raw`\bTimeout ${scenarioNavigationAttemptTimeoutMs}ms exceeded\b`,
  "u",
);

/**
 * Which document took a navigation away from the one that asked for it.
 *
 * A third shape a restart takes, and the only one that never touches the wire.
 * `next dev` keeps a Fast Refresh client in every document it serves; when that
 * client and the server disagree about the build — which is exactly what a
 * memory restart leaves them doing — it reloads the whole document, and the
 * server logs `Fast Refresh had to perform a full reload`. A navigation in
 * flight when that reload lands is ended by it.
 *
 * The engines disagree about what that costs. Reproduced under Playwright
 * 1.62.1 against a page that reloads itself while a `goto` elsewhere is
 * pending: WebKit 2336 ends the `goto` with the message this reads and leaves
 * the page on the reloaded document; Chromium 1234 absorbs the race and lands
 * on the address that was asked for. So the failure only ever appears in the
 * WebKit lane, which is why it appeared for the first time in CI run
 * 33355052056 — five interrupted navigations, each within seconds of one of
 * the six full reloads that run logged, and each naming the address the page
 * was already showing.
 *
 * Returns the address the interrupting navigation went to, or `null` when the
 * failure is not an interruption at all.
 */
const navigationInterrupted =
  /\bis interrupted by another navigation to "([^"]*)"/u;

export function interruptingNavigation(text: string): string | null {
  return navigationInterrupted.exec(text)?.[1] ?? null;
}

/**
 * Whether one failed navigation is a server that did not answer at all.
 *
 * Three ways for that to happen and they are the same event. The transport said
 * so; or the bound this module installed elapsed with nothing said; or the
 * document the page was already showing reloaded itself out from under the
 * request, which delivers no document either. A timeout at any other budget is
 * not this module's — it belongs to whatever set it, and it is an answer from
 * the page rather than the absence of one, so it is re-thrown like every other
 * failure a restart does not explain.
 *
 * `showing` is the address the page held *before* the attempt, and the
 * comparison against it is the whole rule. A page that decides to go somewhere
 * — a client-side redirect, a tenant switch replacing the document — interrupts
 * a navigation in exactly the same words, and that is the page's own answer:
 * asking again would spend this loop's budget racing a decision the application
 * keeps making and then report the server as unreachable. Read *after* the
 * failure the two cannot be told apart, because the interrupting document has
 * committed by then either way; read before, a reload is the one interruption
 * whose destination is the address the page already had.
 *
 * A caller with no document to compare against — every request that is not a
 * navigation — passes nothing, and the clause cannot fire.
 */
export function isUnansweredNavigation(text: string, showing = ""): boolean {
  if (isRestartTransportFailure(text) || attemptBoundReached.test(text)) {
    return true;
  }

  return showing !== "" && interruptingNavigation(text) === showing;
}

/**
 * Navigate, tolerating a restart of the server being navigated to.
 *
 * Generic over what one navigation answers, so the loop can be driven by a
 * scripted attempt in the node lane. A rule that only ever runs inside a
 * browser is a rule nobody can prove says anything.
 */
export async function navigateThroughRestarts<T>(
  navigate: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
  unanswered: (text: string) => boolean = isRestartTransportFailure,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await navigate();
    } catch (failure) {
      if (
        !unanswered(
          failure instanceof Error ? failure.message : String(failure),
        )
      ) {
        throw failure;
      }

      if (attempt >= scenarioNavigationAttempts) {
        throw new Error(scenarioNavigationUnreachable, { cause: failure });
      }

      await sleep(scenarioNavigationBackoffMs);
    }
  }
}

/** Wait out one backing-off period on the wall clock. */
function waitOut(ms: number): Promise<void> {
  return new Promise<void>((done) => {
    setTimeout(done, ms);
  });
}

/**
 * One call across the wire to the development server, made to survive it.
 *
 * A navigation is not the only thing a case puts on that wire. Opening a
 * guarded scenario run and reading the magic-link outbox go to the same
 * server, meet the same restart, and are answered by the same transport — and
 * an open that met one failed a case before the case had begun, exactly as a
 * navigation did.
 *
 * A restart is read here exactly as it is read on the way in, because it is
 * the same event: the transport said the request was never delivered, or the
 * bound the call carried elapsed with the server saying nothing at all. The
 * loop used to read only the first, so a request the restarting server
 * accepted and never answered was handed back to the case as its own timeout —
 * the failure the bound on the navigation path exists to prevent, left
 * standing on the path a case reads a boundary through.
 *
 * What that costs is worth saying plainly. An attempt the transport never
 * delivered changed nothing, so asking again cannot repeat a write; an attempt
 * whose bound elapsed may have been accepted, so asking again may. Every call
 * that reaches this opens a scenario run, resets an outbox or reads one, so a
 * repeat costs a row in a database this suite owns — and the alternative is
 * the case failing at a restart it was wrapped in this loop to survive.
 */
export async function askThroughRestarts<T>(
  call: () => Promise<T>,
): Promise<T> {
  return await navigateThroughRestarts(call, waitOut, isUnansweredNavigation);
}

/** A page method as this module has to hold one to replace it. */
type PageNavigation = (...args: readonly unknown[]) => Promise<unknown>;

/**
 * Give one page's navigations the tolerance above.
 *
 * Installed on the page rather than remembered at each navigation: a spec's
 * page is handed over by the fixture that creates it, and a fixture that opens
 * a page of its own hands it to this on the spot. `scenario-navigation.test.ts`
 * finds every place in this tree that opens a page and refuses one that does
 * not, so a page joins the tolerance by being opened rather than by being
 * remembered.
 *
 * Every method the list above declares is patched, by the list rather than one
 * by one, so a method added there is covered by being added.
 */
export function tolerateRestarts(page: Page): Page {
  const navigations = page as unknown as Record<string, PageNavigation>;

  page.setDefaultNavigationTimeout(scenarioNavigationAttemptTimeoutMs);

  for (const method of scenarioNavigationPageMethods) {
    const navigate = navigations[method].bind(page);

    navigations[method] = async (...args) => {
      // Read at the top of every attempt rather than once for the loop: the
      // document a retry starts from is the one the interrupting reload landed,
      // and the next attempt has to be judged against that one.
      let showing = "";

      return await navigateThroughRestarts(
        async () => {
          showing = page.url();

          return await navigate(...args);
        },
        waitOut,
        (text) => isUnansweredNavigation(text, showing),
      );
    };
  }

  return page;
}

/* ------------------------------------------------------------------ *
 * The third restart loop, and why it lives here.
 * ------------------------------------------------------------------ */
/**
 * Getting a magic link out of a server that restarts itself mid-journey.
 *
 * The same event the two loops above are about, met by the one step in this
 * suite that waiting cannot rescue. It shares their vocabulary, their reading
 * of what an unanswered call is, and the bounds they declare, and it is the
 * third term in what `playwright.config.ts` calls "what this suite can spend
 * waiting out one restart" — so it is argued beside them rather than in a
 * module of its own. That placement is also the only one both readers of this
 * tree can have: the budget test loads this file through Node's own type
 * stripping, which resolves real paths, and the application program compiles
 * it through the specifiers `src` uses, which are the other kind. A module
 * between the two would have to spell one import both ways.
 *
 * The event, in the installed build's own terms. `next dev` compares the heap
 * against its own ceiling at the end of every request and, when the used size
 * crosses the share it watches, calls `process.exit(RESTART_EXIT_CODE)` so its
 * supervisor can start a fresh child — `getMemoryRestartStats` in
 * `next/dist/server/lib/utils.js`, reached from `start-server.js`.
 *
 * The outbox the link is captured into is a `Map` on the serving process's own
 * `globalThis`, keyed by a registered symbol: that is
 * `packages/auth/src/e2e-email-outbox.ts`, and a registered symbol is shared
 * across the modules of one process and across nothing else. So a link
 * captured before the restart is not late, and it is not slow — it exited with
 * the process that held it. Polling for it cannot find it at any budget, which
 * is why the budget was never the whole story: the fixture used to spend a few
 * seconds in all, the outage it was asking across is measured in minutes, and
 * lengthening the wait alone would only have failed later.
 *
 * What recovers it is a second submission, to the child that is now serving.
 * That is the same conclusion `scenario-release.ts` reaches about the register
 * a restart empties, and for the same reason: an in-process store that a
 * restart clears has to be *rebuilt*, not waited for.
 *
 * The ports are injected because the decision is the thing worth proving, and
 * a test that needed a browser and a development server to observe it would be
 * testing those instead.
 */

/**
 * How often the outbox is asked while a link is expected.
 *
 * Short, because when the server is up the answer is already there: the
 * submission is not acknowledged until the action that captures the link has
 * returned, so the poll is a guard rather than a wait. Bounded below the poll
 * budget so a budget is always spent over several answers rather than one.
 */
export const magicLinkPollIntervalMs = 100;

/**
 * How long one submission's link is waited for.
 *
 * One answer from this development server — the same bound the tolerance
 * installs on every navigation to it, taken from the module that installs it
 * rather than written again here. It is the longest a link the server has
 * already captured can take to become readable, because everything longer than
 * one answer is not a slow outbox but an absent one.
 */
export const magicLinkPollBudgetMs = scenarioNavigationAttemptTimeoutMs;

/**
 * How many links may be asked for.
 *
 * The one the journey asks for, and one more for the restart that emptied the
 * outbox it was written into. A submission is only ever invalidated by a
 * restart between it and the lookup that reads it, so one spare covers one
 * restart — and one restart is what this suite has to survive, not a server
 * that keeps exiting.
 *
 * It is not left to be argued from here alone. The budget test requires the
 * recovery below to cover what a restart was measured to cost the lane, so a
 * single submission — which cannot — fails a test rather than a case.
 */
export const magicLinkSubmissions = 2;

/**
 * The wall clock this acquisition can add to a journey.
 *
 * Derived from the loop rather than asserted beside it, so the bound and the
 * behaviour cannot come to disagree. Each submission can spend the navigation
 * tolerance getting the sign-in form answered by a server that is coming back,
 * and then the poll budget asking for what it submitted; both terms are bounds
 * other modules declare.
 */
export const magicLinkDeliveryRecoveryMs =
  magicLinkSubmissions * (scenarioNavigationRecoveryMs + magicLinkPollBudgetMs);

/** What this reports when every submission it may make went unanswered. */
export const magicLinkNotDelivered =
  "Foundation E2E magic link was not delivered";

/**
 * Whether one failed lookup is the server not having answered at all.
 *
 * Read off the sentence rather than the type, because the lookup is wrapped in
 * the block that hides the magic link: what reaches here is that block's own
 * fixed message with the discriminators it recognised appended, and the
 * tolerance's "could not reach the server" is one of them. Anything else is
 * the outbox route's own answer and is re-thrown untouched — a poll that asked
 * again for everything would hide a defect in that route behind a second
 * submission and a slower failure.
 */
function isUnansweredLookup(failure: unknown): boolean {
  const text = failure instanceof Error ? failure.message : String(failure);

  return (
    text.includes(scenarioNavigationUnreachable) ||
    isRestartTransportFailure(text)
  );
}

export type MagicLinkDeliveryPorts = Readonly<{
  /** Ask the outbox for the link; `null` while it holds none. */
  lookup: () => Promise<string | null>;
  /** The wall clock, injected so a budget can be driven without spending it. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Ask the application to send a link, and wait for it to say it did. */
  submit: () => Promise<void>;
}>;

/**
 * Get a magic link, tolerating a restart of the server that has to send it.
 *
 * A lookup the server never answered ends the poll immediately rather than
 * spending the rest of its budget: the server was away, so the outbox that
 * took the previous submission went with it, and the next thing worth doing is
 * submitting again.
 */
export async function acquireMagicLink({
  lookup,
  now,
  sleep,
  submit,
}: MagicLinkDeliveryPorts): Promise<string> {
  let unanswered: unknown;

  for (
    let submission = 1;
    submission <= magicLinkSubmissions;
    submission += 1
  ) {
    await submit();

    const deadline = now() + magicLinkPollBudgetMs;
    for (;;) {
      let found: string | null = null;

      try {
        found = await lookup();
      } catch (failure) {
        if (!isUnansweredLookup(failure)) throw failure;
        unanswered = failure;
        break;
      }

      if (found !== null) return found;
      if (now() >= deadline) break;

      await sleep(magicLinkPollIntervalMs);
    }
  }

  // The last thing the wire said is kept as a cause rather than folded into
  // the message. The block this runs inside reads a cause chain for the
  // sentences this suite owns and repeats those alone, so the transport's own
  // word survives into the CI line without the link going with it.
  throw new Error(magicLinkNotDelivered, { cause: unanswered });
}
