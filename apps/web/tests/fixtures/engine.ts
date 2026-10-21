import { test as base } from "@playwright/test";

import { attachLaneDiagnostics } from "./lane-diagnostics.ts";
import { tolerateRestarts } from "./scenario-navigation.ts";
import { webkitProtocolSkipReason } from "./webkit-support.ts";

/**
 * The `test` every spec in this tree must use.
 *
 * Playwright has no way to say "run this project, unless the host cannot drive
 * its engine": a project is either in the matrix or it is not. Dropping the
 * WebKit projects on a host that cannot run them would make the declared
 * engine list host-dependent, which is the one thing this arrangement must not
 * allow — so both engines stay in the configuration everywhere, and the single
 * known-incompatible host skips the cases instead, with the reason attached to
 * every one of them.
 *
 * The guard is an auto fixture rather than a hook so it cannot be forgotten:
 * `browser-spec-contract.test.ts` fails any spec that imports `test` straight
 * from the package, so a new spec joins the guard by joining the tree.
 */
const webkitSkip = webkitProtocolSkipReason();

export const test = base.extend<{ engineSupport: string | null }>({
  engineSupport: [
    async ({ browserName }, use, testInfo) => {
      if (browserName === "webkit" && webkitSkip !== null) {
        testInfo.skip(true, webkitSkip);
      }
      await use(webkitSkip);
    },
    { auto: true },
  ],
  /**
   * The page a spec is handed, made to survive the server restarting under it.
   *
   * `next dev` restarts itself when its heap crosses the share it watches, and
   * a request in flight when it does is answered by the transport rather than
   * by the server. `scenario-release.ts` taught the release path to wait that
   * out; a `page.goto` racing the same restart was left to fail the case, and
   * it did — `net::ERR_CONNECTION_RESET` on the surface a case was asked to
   * drive, in CI run 33259821308.
   *
   * Installing it on the page is what keeps it off the navigations: there are
   * dozens of those across the specs and the fixtures, and a rule that has to
   * be remembered at each one is a rule that will be missed at the next one.
   * Every spec in this tree already takes its `test` from this module, which
   * `browser-spec-contract.test.ts` enforces, so a navigation joins the
   * tolerance by being written. A fixture that opens a page of its own is
   * handed nothing here and hands that page over on the spot;
   * `scenario-navigation.test.ts` finds every such page and refuses one that
   * is left bare.
   *
   * The lane's own account of what happened to it is attached here too, for
   * the same reason the tolerance is: one place, so no spec can be written
   * without it.
   */
  page: async ({ page }, use) => {
    attachLaneDiagnostics(page);
    await use(tolerateRestarts(page));
  },
});
