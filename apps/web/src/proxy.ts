import { isE2ECspFenceOpen } from "@requestport/server/e2e-csp-fence";
import { type NextRequest, NextResponse } from "next/server";

import {
  requestSecurityHeaders,
  upgradeInsecureRequestsFor,
} from "./lib/security/headers.js";

export function proxy(request: NextRequest) {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const headers = requestSecurityHeaders({
    nonce,
    production: process.env.NODE_ENV === "production",
    canonicalProductionHost: request.nextUrl.hostname === "requestport.com",
    // The acceptance lanes drive a built application over plain loopback, and
    // `next build` folds `process.env.NODE_ENV === "production"` to a constant
    // while building, so the line above is `true` in that server however it was
    // started. Asking a browser to upgrade the transport there asks it for TLS
    // nothing is listening for: WebKit honours the directive on loopback where
    // Chromium exempts it, and CI run 33487078113 lost seventeen of eighteen
    // WebKit cases to 112 `Error performing TLS handshake` lines and a script
    // that never loaded.
    //
    // The first condition is the E2E fence itself rather than a second fence
    // written beside it, and reusing it is what makes this safe to state: it
    // is open only for a *runtime* `NODE_ENV` of `development` or `test`, with
    // the mode flag set and a token of at least thirty-two characters. A
    // production runtime satisfies none of that — `isE2ECspFenceOpen` asks
    // `isE2EEmailMode`, which reads the value off the environment object it is
    // handed rather than through the expression the bundler folds — so the
    // fence never drops the directive in a deployed application. The host
    // reads the same fence through the same module (ruling 174).
    //
    // Beside the fence, the public URL (Plan 13, H.5; manifest-h.md §2.3): a
    // runtime `BETTER_AUTH_URL` that is http on a loopback host drops the
    // directive too. The self-host build is a production build
    // (`apps/requestport/src/web/self-host-build.ts`), `requestport start`'s
    // public URL is `http://127.0.0.1:3200` unless it is told otherwise, and
    // WebKit applies the directive on loopback, asking for TLS nothing there
    // listens for (K5). An https URL keeps it, and so does http on any other
    // host, an unset URL and one that does not parse. Production's URL is
    // `https://requestport.com`. The host applies the same rule to its own
    // public URL (`packages/server/src/host.ts`).
    upgradeInsecureRequests:
      !isE2ECspFenceOpen(process.env) &&
      upgradeInsecureRequestsFor(process.env.BETTER_AUTH_URL),
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set(
    "content-security-policy",
    headers["content-security-policy"],
  );
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [name, value] of Object.entries(headers))
    response.headers.set(name, value);
  if (
    !request.nextUrl.pathname.startsWith("/_next/static/") &&
    !request.nextUrl.pathname.startsWith("/_next/image/")
  ) {
    response.headers.set("cache-control", "private, no-store");
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
