import { auth } from "@requestport/auth/server";
import {
  type AuthOptions,
  handleAuthGet,
  handleAuthPost,
} from "@requestport/server/auth";

import {
  enforceRateLimit,
  rateLimitFingerprint,
  requestIp,
} from "../../../../lib/security/rate-limit.js";

/*
  Better Auth (Plan 13, H.1): `@requestport/server`'s auth handlers, which
  call `auth.handler` as `better-auth/next-js`'s `toNextJsHandler` called it,
  wrapped by `createAuthRouteHandler`, and hold the bounded POST body, the
  two rate-limit classes and the 413, 429 and 500 answers, over the web's
  own collaborators, each passed from the module the route imported it from
  before, and read when a request arrives.
*/
function authOptions(): AuthOptions {
  return {
    auth,
    rateLimiter: {
      fingerprint: rateLimitFingerprint,
      enforce: enforceRateLimit,
    },
    requestIp,
  };
}

export async function GET(request: Request) {
  return handleAuthGet(request, authOptions());
}

export async function POST(request: Request) {
  return handleAuthPost(request, authOptions());
}
