import type { DomainError } from "@requestport/domain";

/**
 * What a refused agent is told, in one place.
 *
 * Every resource this application protects refuses the same credentials for
 * the same reasons, and until now each wrote its own answer: `/mcp` learned to
 * say what to do about a token it cannot read, `/api/v1` kept sending a bare
 * challenge, and the import-artifacts route sent no challenge at all — so the
 * same agent, with the same broken credential, learned three different amounts
 * depending on which address it happened to call. A refusal is part of an API's
 * contract; three copies of one drift, and two of these already had.
 *
 * Moved here from `apps/web/src/lib/security/bearer-challenge.ts` (Plan 13,
 * H.1). The public URL the challenge names is an argument here; the web's
 * module keeps its own `bearerChallenge(resourceMetadataPath, options)` and
 * passes `BETTER_AUTH_URL`, read on each call.
 */

/**
 * The one case worth explaining rather than merely refusing.
 *
 * A refresh that omits the resource indicator gets an opaque access token
 * instead of a JWT. It is a real token this application issued, but no resource
 * here can verify it, so without this the agent receives exactly what a forgery
 * receives and has no way to tell the difference — it retries the same broken
 * credential until its grant expires.
 *
 * A literal, and deliberately so: it goes inside a `WWW-Authenticate`
 * quoted-string, where a `"` or a `\` from an interpolated value would let the
 * description escape its own auth-param. Nothing assembled from an error can
 * promise that; a constant in this file can.
 */
export const reauthorizeWithResourceDescription =
  "The credential presented is not an access token this resource can verify. Authorize again and send the resource indicator from resource_metadata on the authorization request and on every token request, refreshes included.";

/** Whether this refusal is the one the description above explains. */
export function wantsResourceIndicator(error: DomainError) {
  return error.details.reauthorizeWithResource === true;
}

/**
 * The `WWW-Authenticate` value for a resource, per RFC 6750 and RFC 9728.
 *
 * `resourceMetadataPath` is the protected-resource document for the address
 * being refused — each resource has its own, and handing a client another
 * resource's would point it at the wrong audience. It is resolved against
 * `publicUrl`, the issuer, as `new URL` resolves a path against a base.
 */
export function bearerChallenge(
  publicUrl: string,
  resourceMetadataPath: string,
  options: { reauthorizeWithResource?: boolean } = {},
) {
  const resourceMetadata = new URL(resourceMetadataPath, publicUrl).toString();

  return options.reauthorizeWithResource
    ? `Bearer error="invalid_token", error_description="${reauthorizeWithResourceDescription}", resource_metadata="${resourceMetadata}"`
    : `Bearer resource_metadata="${resourceMetadata}"`;
}
