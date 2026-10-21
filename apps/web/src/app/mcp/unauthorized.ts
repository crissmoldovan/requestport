import { unauthorized as unauthorizedWith } from "@requestport/server/unauthorized";

import { bearerChallenge } from "../../lib/security/bearer-challenge.js";

/**
 * The refusal an unauthenticated or unpermitted MCP request receives.
 *
 * Its body moved to `@requestport/server`'s `./unauthorized` (Plan 13, H.1),
 * which the MCP handler the route composes calls with the challenge it is
 * handed. This module keeps `unauthorized(error)` for its test, handing the
 * web's challenge, which names `BETTER_AUTH_URL`, read on each call.
 */
export function unauthorized(error: unknown) {
  return unauthorizedWith(error, bearerChallenge);
}
