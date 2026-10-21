import {
  type AcceptanceSurfaceEntry,
  acceptancePathTokens,
  acceptanceSurfaces,
} from "../../src/test/acceptance-surfaces.js";

/**
 * Every address a lane asks for before it drives its first case.
 *
 * Derived from the surfaces table rather than listed again beside it. A second
 * list would drift the moment a surface is added, and it would drift silently:
 * the address the table gained and this one did not is exactly the address that
 * would still be compiled in the middle of a run.
 *
 * Addresses carrying one of the table's tokens are left out. A token stands for
 * a row the run's own ledger fills in, so there is no single address to ask for
 * — and the segment behind it is compiled by its token-free siblings anyway.
 */
export function warmablePaths(
  surfaces: readonly AcceptanceSurfaceEntry[] = acceptanceSurfaces,
): readonly string[] {
  return [
    ...new Set(
      surfaces
        .map((surface) => surface.path)
        .filter((path) =>
          acceptancePathTokens.every((token) => !path.includes(token)),
        ),
    ),
  ].sort();
}

/**
 * Ask the development server for each address once, so it compiles them all
 * before a case is watching.
 *
 * `next dev` compiles a route on first request and announces the new
 * compilation to every document already open. A document that receives an
 * announcement for work it was not part of tries to apply the update anyway,
 * and reloads itself when it cannot — discarding whatever step the lane had in
 * flight. A compilation that has already happened is never announced twice, so
 * asking first is what keeps the announcements out of the run.
 *
 * What comes back does not matter and is deliberately not checked. An address
 * that answers a redirect, or a not-found, or an error has still been compiled,
 * which is the whole point; asserting on status here would turn a warm-up into
 * a second, weaker copy of the acceptance assertions the cases already make.
 * A request that fails outright is likewise left alone — the case that drives
 * that address will report it far better than this loop could.
 */
export async function warmRoutes(
  baseURL: string,
  request: (url: string) => Promise<unknown>,
  paths: readonly string[] = warmablePaths(),
): Promise<void> {
  for (const path of paths) {
    try {
      await request(new URL(path, baseURL).toString());
    } catch {
      // Deliberately ignored; see above.
    }
  }
}
