import type { FullConfig } from "@playwright/test";

import { warmRoutes } from "./fixtures/route-warmup.js";

/**
 * Compile every address this lane drives, before it opens a document.
 *
 * `next dev` compiles a route the first time it is asked for and announces the
 * new compilation to every document already open. A document that cannot apply
 * that announcement reloads itself, discarding whatever step the lane had in
 * flight — which is how run 33428794819 failed two different steps of one case
 * on its two attempts while the server never went down. Asking first moves
 * every compilation a lane can provoke to a moment when no document exists to
 * be reloaded.
 *
 * It runs here rather than in a fixture for two reasons. Playwright starts the
 * web server in its plugin setup and runs this afterwards, so the server is up
 * exactly once per lane and this is the first thing to touch it. And a fixture
 * would have to live in `fixtures/engine.ts`, which every spec imports for its
 * `test` — importing the surfaces table from there makes every spec in the tree
 * a reader of a checked-in table, which is not a scope that guard was meant to
 * have. CI run 33469446903 is where that was learned.
 *
 * Best-effort by construction: an address behind the session gate answers a
 * redirect to an anonymous request and may not compile its page at all, so this
 * takes away some of the trigger rather than all of it. `lane-diagnostics.ts`
 * is what says how much, by stamping any reload that still happens.
 */
export default async function warmAddresses(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) return;

  await warmRoutes(baseURL, async (url) => {
    await fetch(url, { redirect: "manual" });
  });
}
