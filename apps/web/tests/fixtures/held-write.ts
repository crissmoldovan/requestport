/**
 * Holding a form's write open for a pending-state case, and never letting it go.
 *
 * A pending state is only a state while its request is in flight, so the case
 * holds the request rather than racing it: the driver waits for the write to
 * have been *observed*, asserts on the page while it is pending, and then ends
 * the case.
 *
 * It used to end it by letting the write continue. That handed the mutation to
 * the application at the very moment the runner was releasing the case's
 * scenario, and the two raced. When the mutation won, it had already appended a
 * `domain_events` row naming the scenario's project — a table that is
 * append-only by trigger — so the release's delete of that project was refused
 * and the case failed with `500: E2E scenario cleanup failed: projects` after
 * every one of its own assertions had passed. `route-state-0128` (the project
 * settings form) did exactly that on the `pg` driver, having passed through the
 * hosted driver's proxy before local runs moved; why the proxy hid it was not measured
 * (`docs/implementation/gotchas.md`, 2026-09-29). Nothing the case asserts is
 * about the write's answer, so nothing is lost by refusing it.
 *
 * So the held write is aborted in the browser and never sent: the application
 * does not see it, and a scenario can always be released. Any write the page
 * attempts after that is refused the same way, because the case is over and
 * whatever it asked for would race the release just as the held one did. A
 * write the page makes *while* the first is held is neither held nor refused —
 * it falls through to the run's origin guard as it always did, because
 * refusing it could change the page the case is still asserting on — but it is
 * counted (`writesLetThrough`), and the pending driver requires the count to be
 * zero. So a pending case that sent any write to the application fails on the
 * page, not only one whose held write escaped.
 *
 * The page and route are narrowed to the calls made here so the decision can
 * be proven without a browser (`src/test/held-write.test.ts`).
 */

/** The part of a Playwright `Route` this module uses. */
export type HeldWriteRoute = {
  abort: (errorCode?: string) => Promise<void>;
  fallback: () => Promise<void>;
  request: () => { method: () => string };
};

/** The part of a Playwright `Page` this module uses. */
export type HeldWritePage<TRoute extends HeldWriteRoute> = {
  route: (
    url: string,
    handler: (route: TRoute) => Promise<void>,
  ) => Promise<unknown>;
};

export type HeldWrite<TRoute extends HeldWriteRoute> = Readonly<{
  /** Resolves with the held route once the page has made its write. */
  observed: Promise<TRoute>;
  /**
   * End the hold by aborting the write, never by sending it.
   *
   * Safe to call whether or not a write was ever held, and more than once:
   * it is called from a `finally`, so a case that failed before its write left
   * the page still reaches it. Resolves once the abort has been delivered.
   */
  abandon: () => Promise<void>;
  /**
   * How many writes the page made while the first was held. Each went on to
   * the application; a pending case expects none.
   */
  writesLetThrough: () => number;
}>;

export async function holdNextWrite<TRoute extends HeldWriteRoute>(
  page: HeldWritePage<TRoute>,
): Promise<HeldWrite<TRoute>> {
  let markObserved: (route: TRoute) => void = () => undefined;
  const observed = new Promise<TRoute>((resolve) => {
    markObserved = resolve;
  });
  let endHold: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    endHold = resolve;
  });
  let heldAborted: Promise<void> = Promise.resolve();
  let holding = false;
  let abandoned = false;
  let awaiting = true;
  let letThrough = 0;

  const handler = async (route: TRoute) => {
    if (route.request().method() === "POST") {
      if (abandoned) {
        await route.abort("aborted");
        return;
      }
      if (awaiting) {
        awaiting = false;
        holding = true;
        let delivered: () => void = () => undefined;
        heldAborted = new Promise<void>((resolve) => {
          delivered = resolve;
        });
        markObserved(route);
        await ended;
        try {
          await route.abort("aborted");
        } finally {
          delivered();
        }
        return;
      }
      letThrough += 1;
    }
    // `fallback`, not `continue`: the run installs an origin guard of its own
    // and a handler registered later runs first, so continuing here would step
    // around it and let a submission reach a third party.
    await route.fallback();
  };
  await page.route("**/*", handler);

  return {
    abandon: async () => {
      abandoned = true;
      endHold();
      if (holding) await heldAborted;
    },
    observed,
    writesLetThrough: () => letThrough,
  };
}
