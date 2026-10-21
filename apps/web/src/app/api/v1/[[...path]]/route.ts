import { authenticateApiBearer } from "@requestport/auth/server";
import {
  handleRestCommand,
  handleRestQuery,
  type RestOptions,
} from "@requestport/server/rest";

import { withProject } from "../../../../lib/agent-project-scope.js";
import { bearerChallenge } from "../../../../lib/security/bearer-challenge.js";
import {
  enforceRateLimit,
  rateLimitFingerprint,
} from "../../../../lib/security/rate-limit.js";
import { webRequestPort } from "../../../../lib/server-web-request-port.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
  The REST API (Plan 13, H.1): `@requestport/server`'s handlers, which hold
  the envelope, its bound, the error mapping and every step before the
  RequestPort, over the web's own collaborators, each passed from the module
  the route imported it from before, and read when a request arrives. The
  web's RequestPort is handed as the function that answers it, so it is
  asked for only as a query or a command runs; core's `query` and `execute`
  hold every dispatch. The path's parts are Next's, read from the catch-all,
  if at all, only after the request is authenticated and limited.
*/
function restOptions(): RestOptions {
  return {
    authenticateApiBearer,
    rateLimiter: {
      fingerprint: rateLimitFingerprint,
      enforce: enforceRateLimit,
    },
    requestPort: webRequestPort,
    withProject,
    challenge: bearerChallenge,
  };
}

async function pathParts(context: { params: Promise<{ path?: string[] }> }) {
  return (await context.params).path ?? [];
}

export async function GET(
  request: Request,
  routeContext: { params: Promise<{ path?: string[] }> },
) {
  return handleRestQuery(request, () => pathParts(routeContext), restOptions());
}

export async function POST(
  request: Request,
  routeContext: { params: Promise<{ path?: string[] }> },
) {
  return handleRestCommand(
    request,
    () => pathParts(routeContext),
    restOptions(),
  );
}
