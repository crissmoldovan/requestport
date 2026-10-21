import { DomainError } from "@requestport/domain";
import { createLocalJWKSet, jwtVerify } from "jose";

/**
 * Verify an agent's OAuth access token against the audience it was issued for.
 *
 * Better Auth's `verifyJWT` endpoint checks `aud` against the issuer's own
 * origin and offers no way to say otherwise — only `issuer` can be overridden.
 * An agent's access token does not carry the origin: it carries the resource
 * it was minted for, `…/mcp` or `…/api/v1`, because the whole point of a
 * resource indicator is that a token for one is not a token for the other.
 *
 * So every OAuth access token this application issued failed verification with
 * `unexpected "aud" claim value`, the bearer path read that as an invalid
 * token, and every agent request was refused as unauthenticated. Consent
 * completed, a code was issued, a grant was written, and the credential at the
 * end of it could not be used for anything.
 *
 * Configuring `jwt.audience` would have fixed the verification and broken the
 * signing with it: the same option is the default `aud` for every other token
 * this application signs, and a session token minted with a resource audience
 * is a session token no longer about this origin.
 *
 * Both resource audiences are accepted here, and which one was required is
 * decided afterwards by `exactAudience`, which admits exactly one and compares
 * it to the audience the endpoint asked for. Widening here does not widen
 * there.
 */
export function createAgentAccessTokenVerifier(dependencies: {
  audiences: readonly string[];
  issuer: string;
  jwks: () => Promise<{ keys: unknown[] }>;
}) {
  return async function verifyAgentAccessToken(token: string) {
    /*
      Reading the keys and judging the token are different failures.

      They shared a `catch`, so a database blip or an unreadable key set
      answered the agent with "unauthenticated" — the same answer a forged
      credential gets. A client that believes that discards a good token and
      takes its person back through consent for nothing, while the outage
      looks like a credential problem to everyone reading the logs.
    */
    let keySet: ReturnType<typeof createLocalJWKSet>;
    try {
      keySet = createLocalJWKSet(
        (await dependencies.jwks()) as Parameters<typeof createLocalJWKSet>[0],
      );
    } catch {
      throw new DomainError(
        "configuration_error",
        "The signing keys could not be read",
      );
    }

    try {
      const { payload } = await jwtVerify(token, keySet, {
        audience: [...dependencies.audiences],
        issuer: dependencies.issuer,
        // `jwtVerify` checks `exp` only when a token carries one. Every token
        // the provider mints does, so one without it is refused here as well
        // as by the bearer path that reads this payload.
        requiredClaims: ["exp"],
      });

      return payload;
    } catch {
      // A token that does not verify is not a token. The reason belongs in the
      // refusal the caller raises, not in a value this returns.
      return null;
    }
  };
}
