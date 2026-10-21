/**
 * Which origins Client ID Metadata Documents may be fetched from.
 *
 * With CIMD on, an unauthenticated client names a URL as its `client_id` and
 * the authorisation server fetches it. `@better-auth/cimd` admits every URL
 * that passes its own syntactic check unless it is given
 * `isMetadataDocumentUrlAllowed`, so the composition always gives it the
 * predicate below, built from an explicit list: nothing is fetched from an
 * origin the owner did not name.
 *
 * Kept apart from `server-options.ts` so it is tested without composing
 * Better Auth. It parses URLs and resolves nothing, so a refusal happens
 * before any DNS lookup or connection.
 */

export const CIMD_ALLOWED_ORIGINS_VARIABLE =
  "REQUESTPORT_OAUTH_CIMD_ALLOWED_ORIGINS";

function refuse(entry: string, reason: string): never {
  throw new Error(
    `${CIMD_ALLOWED_ORIGINS_VARIABLE} entry ${JSON.stringify(entry)} ${reason}; each entry must be an https origin with no userinfo, path, query, fragment or wildcard`,
  );
}

/**
 * The list, from its comma-separated form, each entry as its URL `origin`: the
 * host lowercased and in its ASCII form, and port 443 dropped. Throws, naming
 * the variable, when the list is missing, holds no entry, or holds one entry
 * that is not an https origin.
 */
export function parseCimdAllowedOrigins(value: string | undefined): string[] {
  const entries = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    throw new Error(
      `${CIMD_ALLOWED_ORIGINS_VARIABLE} must name at least one https origin when REQUESTPORT_OAUTH_CIMD is enabled`,
    );
  }

  const origins = new Set<string>();
  for (const entry of entries) {
    if (entry.includes("*")) refuse(entry, "holds a wildcard");
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      refuse(entry, "is not a URL");
    }
    if (url.protocol !== "https:") refuse(entry, "is not https");
    if (url.username || url.password || entry.includes("@")) {
      refuse(entry, "carries userinfo");
    }
    if (url.pathname !== "/") refuse(entry, "carries a path");
    if (url.search || entry.includes("?")) refuse(entry, "carries a query");
    if (url.hash || entry.includes("#")) refuse(entry, "carries a fragment");
    origins.add(url.origin);
  }
  return [...origins];
}

/**
 * Admits a `client_id` URL only when it parses, carries no userinfo, and its
 * origin equals one entry exactly: scheme, host and port. There are no
 * suffix rules, so a subdomain, a longer host or another port is refused.
 */
export function createCimdOriginPredicate(origins: readonly string[]) {
  const allowed = new Set(origins);
  return (clientIdUrl: string) => {
    let url: URL;
    try {
      url = new URL(clientIdUrl);
    } catch {
      return false;
    }
    if (url.username || url.password) return false;
    return allowed.has(url.origin);
  };
}
