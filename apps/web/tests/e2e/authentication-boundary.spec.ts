import { expect } from "@playwright/test";

import { test } from "../fixtures/engine.ts";
import {
  askThroughRestarts,
  scenarioNavigationAttemptTimeoutMs,
} from "../fixtures/scenario-navigation.ts";

/**
 * What an anonymous client is told at a protected URL.
 *
 * The suite next door drives a browser to `/` and waits for `/sign-in`, and a
 * browser cannot tell the two answers apart: it follows a redirect status and
 * it obeys a `<meta http-equiv="refresh">`, so the one assertion the journey
 * makes passes either way. Everything that is not a browser can tell them
 * apart, and the difference is the whole boundary — a success status at a
 * protected URL carrying the sign-in document is an answer, and an answer is
 * what a protected route must never give.
 *
 * `redirect()` becomes a status only while nothing has been sent. React
 * finishes everything outside a Suspense boundary and the server flushes it, so
 * any loading boundary above the segment that decides authentication commits
 * the response first and leaves `redirect()` nothing but the meta refresh.
 * `src/test/authentication-boundary.test.ts` reads that position off the tree
 * in the node lane; this case is the same rule observed on the wire, which is
 * where `scripts/staging-http-smoke.mjs` will read it when this build reaches
 * staging.
 *
 * Read through the request context rather than the page, because a page has no
 * way to report the answer it was given before it followed it.
 */

/** Routes whose answer is a decision about the caller, not a document. */
const guardedPaths = ["/", "/requests", "/oauth/agent-consent"] as const;

/** A route that answers everyone, so "everything redirects" cannot pass. */
const openPath = "/sign-in";

/** What Next sends when `redirect()` runs before the response is committed. */
const redirectStatus = 307;

/**
 * Bounded the way every navigation in this tree is bounded.
 *
 * This probe used to opt out of a budget altogether, on the reasoning that a
 * development server compiles a route on first request and only the case's own
 * budget should decide how long that may take. That reasoning is wrong about
 * the failure it has to survive: the socket `next dev`'s supervisor holds
 * keeps accepting while no child is serving, so a request in flight is neither
 * delivered nor refused, and a wait with no bound ends only when the case does.
 *
 * So the ask carries the same bound the tolerance installs on a page, from the
 * same binding, and the loop around it reads that bound elapsing as the server
 * not answering and asks again. Redirects are still not followed, because the
 * status and the location are the whole assertion.
 */
const answer = {
  maxRedirects: 0,
  timeout: scenarioNavigationAttemptTimeoutMs,
} as const;

test.describe(`@route-state anonymous boundary`, () => {
  test("answers a guarded route with a redirect rather than a document", async ({
    request,
  }) => {
    const answers: {
      location: string | undefined;
      path: string;
      status: number;
    }[] = [];

    for (const path of [...guardedPaths, openPath]) {
      // Through the same tolerance every navigation in this tree has. The
      // probe is read from the request context rather than from a page, so it
      // is not one of the page methods that arrangement patches, and a server
      // that restarted between two paths would answer this one with a reset
      // rather than with the decision under test.
      const response = await askThroughRestarts(
        async () => await request.get(path, answer),
      );
      answers.push({
        location: response.headers().location,
        path,
        status: response.status(),
      });
    }

    expect(answers).toEqual([
      ...guardedPaths.map((path) => ({
        location: openPath,
        path,
        status: redirectStatus,
      })),
      { location: undefined, path: openPath, status: 200 },
    ]);
  });
});
