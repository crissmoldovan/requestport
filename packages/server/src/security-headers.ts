/**
 * The security headers the web's proxy sets on every response its matcher
 * covers (Plan 13, H.1; manifest-h.md §2.2): the content security policy with
 * a nonce, and the permissions, referrer, content-type and framing policies,
 * with HSTS on the canonical production host.
 *
 * Moved here from `apps/web/src/lib/security/headers.ts`, which re-exports it
 * under the same name for `apps/web/src/proxy.ts` and its tests. The host sets
 * the same headers on the answers its families give (`host.ts`). This module
 * imports nothing, so the proxy's bundle gains nothing by reaching it.
 */
export function requestSecurityHeaders(input: {
  nonce: string;
  production: boolean;
  canonicalProductionHost: boolean;
  /**
   * Whether to ask the browser to upgrade this document's requests to TLS.
   *
   * Defaults to the production policy and can only ever narrow it: a
   * non-production policy never carries the directive whatever this says. It
   * exists because this is the one directive a production build cannot honour
   * on the origin the acceptance lanes drive — a built application served over
   * plain loopback — and because WebKit applies it there while Chromium
   * exempts loopback. Everything else `production` decides, `script-src` above
   * most of all, stays exactly as it ships. `proxy.ts` and the host each pass
   * `upgradeInsecureRequestsFor` of the public URL, below, beside the
   * end-to-end fence.
   */
  upgradeInsecureRequests?: boolean;
}) {
  const script = input.production
    ? `'nonce-${input.nonce}' 'strict-dynamic'`
    : `'nonce-${input.nonce}' 'strict-dynamic' 'unsafe-eval'`;
  const csp = [
    "default-src 'self'",
    `script-src 'self' ${script}`,
    // CUE++ providers and components publish bounded inline `style` attributes
    // for `color-scheme`, the font scale, and component-owned dynamic geometry.
    // Splitting the style directives keeps that narrow exception on attributes
    // alone: stylesheet elements stay nonce/self restricted and scripts never
    // gain an inline source.
    "style-src 'self'",
    `style-src-elem 'self' 'nonce-${input.nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self' https: wss:",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://github.com https://slack.com",
    ...(input.production && (input.upgradeInsecureRequests ?? true)
      ? ["upgrade-insecure-requests"]
      : []),
  ].join("; ");
  return {
    "content-security-policy": csp,
    "permissions-policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    ...(input.canonicalProductionHost
      ? {
          "strict-transport-security":
            "max-age=63072000; includeSubDomains; preload",
        }
      : {}),
  };
}

/**
 * Whether a document served for this public URL may ask the browser to
 * upgrade its requests to TLS (Plan 13, H.5; manifest-h.md §2.3): `false`
 * only when the URL parses, is `http:` and names a loopback host; `true`
 * otherwise, an unset or unparsable URL included.
 *
 * `requestport start` serves a production runtime, at `http://127.0.0.1:3200`
 * unless told otherwise, and WebKit applies the directive on loopback, asking
 * for TLS that nothing there listens for (K5; ruling 108). An https URL keeps
 * the directive, and so does http on any other host. Production's
 * `BETTER_AUTH_URL` is `https://requestport.com`, so production keeps it.
 *
 * The loopback test restates `isLoopbackHostname` in
 * `packages/auth/src/server-options.ts`, the issuer's rule (`localhost`,
 * `*.localhost`, 127.0.0.0/8 and `[::1]`), because this module imports
 * nothing. `security-headers.test.ts` holds it to the rows of
 * `packages/client/src/origin-rule.cases.json`, the table the issuer's rule
 * is held to. That rule refuses http on any other host, so every http URL a
 * server can be its own issuer on drops the directive.
 */
export function upgradeInsecureRequestsFor(
  publicUrl: string | undefined,
): boolean {
  if (publicUrl === undefined) return true;
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    return true;
  }
  if (url.protocol !== "http:") return true;
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  const loopback =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host);
  return !loopback;
}
