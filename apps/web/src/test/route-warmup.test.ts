import { describe, expect, test } from "vitest";

import { warmablePaths } from "../../tests/fixtures/route-warmup.js";
import {
  acceptancePathTokens,
  acceptanceSurfaces,
} from "./acceptance-surfaces.js";

/**
 * The addresses a lane compiles before it drives anything.
 *
 * `next dev` compiles a route the first time something asks for it, and it
 * tells every connected document when it has: the hot-reload client compares
 * the new compilation hash against its own, tries to apply an update it was
 * never part of, and falls back to `window.location.reload()` when it cannot.
 * The reload lands on whichever step was in flight, which is why run
 * 33428794819 failed two different steps of one case on its two attempts while
 * the server itself never went down.
 *
 * Asking for every address first is what takes the trigger away: a compilation
 * that has already happened is not announced again. The list is derived from
 * the surfaces table rather than restated beside it, because a second list is
 * a list that will disagree — an address the table gains and this one does not
 * would be compiled mid-run again, and nothing would say so.
 *
 * Addresses carrying a token are left out. A token stands for a row the run's
 * own ledger fills in, so there is no one address to ask for; the segment they
 * live in is compiled by its token-free siblings anyway.
 */

describe("the addresses a lane compiles up front", () => {
  test("takes every token-free address the surfaces table names", () => {
    const expected = [
      ...new Set(
        acceptanceSurfaces
          .map((surface) => surface.path)
          .filter((path) =>
            acceptancePathTokens.every((token) => !path.includes(token)),
          ),
      ),
    ].sort();

    expect(warmablePaths()).toEqual(expected);
  });

  test("leaves out the addresses that carry a token", () => {
    // Planted, because a filter that dropped nothing would still satisfy a
    // check written against the same filter, and a request for `/agents/:missing`
    // would compile nothing while looking like it had.
    const tokened = acceptanceSurfaces
      .map((surface) => surface.path)
      .filter((path) =>
        acceptancePathTokens.some((token) => path.includes(token)),
      );

    expect(tokened.length).toBeGreaterThan(0);
    for (const path of warmablePaths()) {
      expect(tokened).not.toContain(path);
    }
  });

  test("answers a real list, and one the table actually carries", () => {
    // A reader that answered nothing would take the trigger away by warming
    // no address at all, and pass both checks above in silence.
    const paths = warmablePaths();

    expect(paths.length).toBeGreaterThan(5);
    expect(paths).toContain("/");
    expect(paths).toContain("/settings/appearance");
    expect(new Set(paths).size).toBe(paths.length);
  });
});
