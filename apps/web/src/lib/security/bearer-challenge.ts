/*
  What a refused agent is told (Plan 13, H.1). The challenge, its one
  explained refusal and the reasons for both moved to `@requestport/server`'s
  `./bearer-challenge`, which takes the public URL as an argument. This
  module keeps its exports for the web's importers, and its
  `bearerChallenge(resourceMetadataPath, options)` names `BETTER_AUTH_URL`,
  read on each call as before.
*/
import { serverEnv } from "@requestport/config/server";
import { bearerChallenge as bearerChallengeAt } from "@requestport/server/bearer-challenge";

export {
  reauthorizeWithResourceDescription,
  wantsResourceIndicator,
} from "@requestport/server/bearer-challenge";

/**
 * The `WWW-Authenticate` value for a resource, per RFC 6750 and RFC 9728,
 * naming the protected-resource document at `resourceMetadataPath` on this
 * deployment's `BETTER_AUTH_URL`.
 */
export function bearerChallenge(
  resourceMetadataPath: string,
  options: { reauthorizeWithResource?: boolean } = {},
) {
  return bearerChallengeAt(
    serverEnv.BETTER_AUTH_URL,
    resourceMetadataPath,
    options,
  );
}
