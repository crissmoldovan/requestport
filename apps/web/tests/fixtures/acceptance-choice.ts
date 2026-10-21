/**
 * Answering one choice control on a surface the driver did not write.
 *
 * A `Select` portals its popup, so the popup lands in a commit *after* the
 * click rather than in it. Asking how many options are listed in the same
 * breath as the click therefore asks a document the popup has not reached
 * yet: the query answers none, the choice is abandoned as an empty list, and
 * a required select is left unanswered. The surface then reports that as a
 * *text* control which would accept no value, naming a field the driver never
 * typed into — which is the failure this arrangement exists to make
 * impossible, and the one the route/state lane met on the new-request surface.
 *
 * The steps are ports rather than locators because the defect is an ordering,
 * and an ordering that can only be observed inside a browser is one nothing
 * can hold. `acceptance-choice.test.ts` drives them with a scripted popup that
 * commits late — exactly as the real one does — and fails if the count is read
 * before the popup has settled.
 */

/** What one choice control can be asked to do. */
export type AcceptanceChoicePorts = Readonly<{
  /** Take the first option the settled popup lists. */
  choose: () => Promise<void>;
  /** Wait until the popup is gone again. */
  closed: () => Promise<void>;
  /** Dismiss a popup that lists nothing to take. */
  dismiss: () => Promise<void>;
  /** How many options the settled popup lists. */
  listed: () => Promise<number>;
  /** Open the popup. */
  open: () => Promise<void>;
  /**
   * Wait for the popup to commit.
   *
   * The step this arrangement exists for. It is a wait rather than a pause:
   * the popup is asked for until it is there, so a slow commit costs what it
   * costs and a popup that never arrives fails as the popup that never
   * arrived. The list mounts with the popup, so once this returns the count
   * below is an answer rather than a sample.
   */
  settled: () => Promise<void>;
}>;

/** Answer one choice control, or dismiss it when it offers nothing. */
export async function answerChoice(
  ports: AcceptanceChoicePorts,
): Promise<void> {
  await ports.open();
  await ports.settled();
  if ((await ports.listed()) > 0) await ports.choose();
  else await ports.dismiss();
  await ports.closed();
}
