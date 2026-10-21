import { authenticateAgentBearer } from "@requestport/auth/server";
import { serverEnv } from "@requestport/config/server";
import { handleMcp, type McpOptions } from "@requestport/server/mcp";

import { withProject } from "../../lib/agent-project-scope.js";
import { webLogger, webMetrics } from "../../lib/observability.js";
import { bearerChallenge } from "../../lib/security/bearer-challenge.js";
import {
  enforceRateLimit,
  rateLimitFingerprint,
} from "../../lib/security/rate-limit.js";
import { workspaceEncryption } from "../../lib/server-core-commands.js";
import { webRequestPort } from "../../lib/server-web-request-port.js";

/*
  MCP (Plan 13, H.1): `@requestport/server`'s handler, an adapter over core
  (G.6; ruling 137), which holds the media-type check, the bounded body, the
  rate-limit classes, every dependency the MCP server is handed, the refusal
  and the metrics, over the web's own collaborators, each passed from the
  module the route imported it from before, and read when a request
  arrives. The web's RequestPort (`webRequestPort()`, composed over the web
  root's storage) is asked for by the handler once a request is
  authenticated and limited, and every tool runs on it.

  `REQUESTPORT_MCP_MODERN` is judged here, on each request: exactly
  "enabled" turns the 2026-07-28 leg on. Private telemetry is accepted
  where the web's workspace encryption is configured.

  Receipts are keyed from `BETTER_AUTH_SECRET`, which the RequestPort reads
  from `serverEnv`, in three ways:
  - the command bus the registry tools run on, `provision_agent`'s
    `create_agent_principal` among them, keys its receipts with a key derived
    from it (`commandFingerprintSecret`), derived once, when the RequestPort
    is composed;
  - `register_project`, the import tools that keep a receipt (`analyze`,
    `apply` and `correct`), the delivery replay and `provision_agent`'s key
    issuance key theirs with it raw, read when each runs;
  - the webhook management service keys its receipts with it raw, read once,
    when the service is composed at the first read of `mcpOnly.webhooks`.
*/
function mcpOptions(): McpOptions {
  return {
    authenticateAgentBearer,
    rateLimiter: {
      fingerprint: rateLimitFingerprint,
      enforce: enforceRateLimit,
    },
    requestPort: () => webRequestPort(),
    withProject,
    challenge: bearerChallenge,
    privateTelemetry: () => Boolean(workspaceEncryption),
    modernProtocol: () => serverEnv.REQUESTPORT_MCP_MODERN === "enabled",
    logger: webLogger,
    metrics: webMetrics,
  };
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handler(request: Request) {
  return handleMcp(request, mcpOptions());
}

export const GET = handler;
export const POST = handler;
export const DELETE = handler;
