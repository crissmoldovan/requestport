/**
 * What Next serves for a route behind the web's proxy (`apps/web/src/proxy.ts`):
 * the proxy's response headers over the route's (ruling 147, question 4).
 *
 * As `next@16.3.1` merges them in a Node server (`next start`, or a custom
 * server over Next's request handler), **read**:
 *
 * - `dist/server/lib/router-utils/resolve-routes.js:411-465`: the proxy's
 *   response headers are kept for the outgoing response, except Next's own
 *   `x-middleware-*` headers, `content-length`, an empty value, and the
 *   names `ipcForbiddenHeaders` lists (`dist/server/lib/server-ipc/utils.js:31-41`);
 * - `dist/server/lib/router-server.js:395-398`: they are set on the outgoing
 *   response before the route runs;
 * - `dist/server/send-response.js:28-53`: the route's headers are then
 *   added: `set-cookie`, `www-authenticate`, `proxy-authenticate` and `vary`
 *   appended, and every other header only where the proxy set none.
 *
 * So a header both set is the proxy's: its `cache-control: private,
 * no-store` replaces a discovery document's `public, max-age=300`, as H.0b
 * measured on a Next server (K1a). Next's own `vary` on an App Router
 * response, which that measurement also showed, is Next's and not the
 * proxy's, and is not modelled here. Vercel's edge merge was not measured.
 *
 * The request a route is handed is the case's own: the proxy's request
 * headers (`x-nonce` and `content-security-policy`, and the response headers
 * `resolve-routes.js:463` also copies onto the request) are not added
 * to it. Outside tests, no module under `apps/web/src` or each `packages/<name>/src`
 * reads one of those names from a request but the root layout, a page, which
 * reads `x-nonce` (`rg`, at 5001fa1b). Better Auth and the MCP SDK, which the
 * auth and MCP routes hand the request to, were not searched.
 */

/** Names the proxy's response cannot carry onto the outgoing response. */
const notForwarded = new Set([
  "content-length",
  // ipcForbiddenHeaders
  "accept-encoding",
  "keepalive",
  "keep-alive",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "expect",
]);

/** A route's headers Next appends beside the proxy's, rather than drops. */
const appended = new Set([
  "set-cookie",
  "www-authenticate",
  "proxy-authenticate",
  "vary",
]);

/** The response Next writes: the proxy's headers, then the route's where allowed. */
export function servedByNext(proxied: Response, route: Response): Response {
  const headers = new Headers();
  for (const [name, value] of proxied.headers) {
    if (name.startsWith("x-middleware-") || notForwarded.has(name) || !value) {
      continue;
    }
    headers.append(name, value);
  }
  const fromProxy = new Set(headers.keys());
  for (const [name, value] of route.headers) {
    if (appended.has(name) || !fromProxy.has(name)) headers.append(name, value);
  }
  return new Response(route.body, {
    status: route.status,
    statusText: route.statusText,
    headers,
  });
}

/** Whether one of the proxy's `config.matcher` patterns covers `pathname`. */
export function proxyMatches(
  matchers: readonly string[],
  pathname: string,
): boolean {
  return matchers.some((matcher) =>
    new RegExp(`^${matcher}$`, "u").test(pathname),
  );
}
