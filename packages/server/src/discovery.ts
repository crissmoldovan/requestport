/**
 * The four discovery documents, from one function of the public URL (Plan 13,
 * H.1; manifest-h.md §2.2).
 *
 * The authorization server's metadata and its OpenID configuration are
 * Better Auth's own handlers, handed in and served as they are. The two
 * protected-resource documents (RFC 9728) are built here from the public
 * URL, the issuer: they moved out of the web's routes under
 * `apps/web/src/app/.well-known/oauth-protected-resource/`, which now answer
 * with `protectedResourceMetadata`, so the host and Vercel serve one
 * document.
 *
 * Each protected-resource document is answered `cache-control: public,
 * max-age=300`. Behind the web's proxy, and from the host, the proxy's
 * `private, no-store` replaces it (H.0b's K1a, measured on a Next server;
 * ruling 147).
 */
import { agentScopes } from "@requestport/domain";

import type { RequestPortHandler } from "./node.js";

export type ProtectedResource = "api" | "mcp";

/**
 * The scopes the MCP document advertises, verbatim from its route. Not
 * `agentScopes`: it also names the OpenID scopes and `project:provision`.
 */
const mcpScopes = [
  "openid",
  "offline_access",
  // Advertised so a client can discover it. Exclusive: a grant carrying
  // it carries nothing else, which the authorization server enforces.
  "project:provision",
  "org:read",
  "project:read",
  "request:create",
  "request:read",
  "request:write",
  "request:triage",
  "request:complete",
  "request:verify",
  "question:answer",
  "work:claim",
  "work:update",
  "agent:register",
  "webhook:manage",
  "import:write",
];

/** The protected-resource document for `/api/v1` or for `/mcp`. */
export function protectedResourceDocument(
  publicUrl: string,
  resource: ProtectedResource,
) {
  const baseUrl = publicUrl.replace(/\/$/u, "");
  return resource === "api"
    ? {
        resource: `${baseUrl}/api/v1`,
        authorization_servers: [baseUrl],
        bearer_methods_supported: ["header"],
        scopes_supported: agentScopes,
        resource_documentation: `${baseUrl}/docs/api`,
      }
    : {
        resource: `${baseUrl}/mcp`,
        authorization_servers: [baseUrl],
        bearer_methods_supported: ["header"],
        scopes_supported: mcpScopes,
        resource_documentation: `${baseUrl}/docs/mcp`,
      };
}

/** The protected-resource document, answered as JSON, cacheable for five minutes. */
export function protectedResourceMetadata(
  publicUrl: string,
  resource: ProtectedResource,
): Response {
  return Response.json(protectedResourceDocument(publicUrl, resource), {
    headers: { "cache-control": "public, max-age=300" },
  });
}

export interface DiscoveryOptions {
  /** The issuer, `BETTER_AUTH_URL`. */
  publicUrl: string;
  /** Better Auth's `/.well-known/oauth-authorization-server` handler. */
  oauthAuthorizationServerMetadata: RequestPortHandler;
  /** Better Auth's `/.well-known/openid-configuration` handler. */
  oauthOpenIdConfiguration: RequestPortHandler;
}

/** The four documents' handlers, by the route table's names. */
export function discovery(options: DiscoveryOptions): Readonly<{
  "authorization-server-metadata": RequestPortHandler;
  "openid-configuration": RequestPortHandler;
  "protected-resource-api": RequestPortHandler;
  "protected-resource-mcp": RequestPortHandler;
}> {
  return {
    "authorization-server-metadata": options.oauthAuthorizationServerMetadata,
    "openid-configuration": options.oauthOpenIdConfiguration,
    "protected-resource-api": async () =>
      protectedResourceMetadata(options.publicUrl, "api"),
    "protected-resource-mcp": async () =>
      protectedResourceMetadata(options.publicUrl, "mcp"),
  };
}
