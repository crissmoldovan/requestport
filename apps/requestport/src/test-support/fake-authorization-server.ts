import type { CallbackReceiver } from "@requestport/client/authorize";
import { AGENT_SCOPES, type FetchLike } from "@requestport/client/oauth";
import { createTokenSource } from "@requestport/client/token-source";

import type { AskWhoami } from "../agent-authorization.js";
import { askWhoami } from "../agent-authorization.js";
import { HOLDING_PROJECT_ID } from "../holding-store.js";

/**
 * An authorization server in memory, for the unit tests of the login flow:
 * discovery, registration, the code and refresh grants (each refresh
 * rotating), REST's `whoami`, and a stateless `/mcp` answering JSON as the
 * host's does with the modern leg off (`initialize`, `tools/list`, and
 * `tools/call` for `whoami` and `list_projects`), each answered for the
 * project the consent chose.
 * No socket, no browser: `consent` stands for the person, and the receiver it
 * hands back stands for the loopback listener. `login.integration.test.ts`
 * runs the same flow against the real host.
 */
export interface FakeAuthorizationServer {
  readonly origin: string;
  readonly fetch: FetchLike;
  /** The receiver `authorize` starts; its callback is settled by `consent`. */
  startCallbackReceiver(): CallbackReceiver;
  /**
   * The person: approves the authorization URL for `projectId` (the next
   * project in `grants` unless given), and the browser lands on the
   * receiver with the code.
   */
  consent(url: string, projectId?: string): void;
  /** The projects the next consents choose, in order. */
  readonly grants: string[];
  readonly registrations: string[];
  /** Each refresh received: the client and the token presented. */
  readonly refreshes: { clientId: string; refreshToken: string }[];
  /** While true, every refresh is answered `invalid_grant`. */
  refuseRefreshes: boolean;
  /** Whether the next consent's callback carries `iss`. */
  sendIssuer: boolean;
  /** The scopes `/mcp`'s `whoami` answers. `AGENT_SCOPES` unless changed. */
  mcpScopes: string[];
  /** The slug `/mcp`'s `list_projects` answers for a project. */
  slugOf: (projectId: string) => string;
  /** Each tool `/mcp` was asked to call, in order. */
  readonly mcpCalls: string[];
  /**
   * Each JSON-RPC message `/mcp` received, in order: its method (or
   * `(response)`) and the `mcp-protocol-version` header it came with.
   */
  readonly mcpMessages: { method: string; protocolVersion: string | null }[];
  /**
   * While set, every request to `/mcp` but `initialize` fails: answered
   * with that status and body, or, for `throws`, the request itself rejects
   * with that error, as `fetch` does when the server cannot be reached.
   */
  mcpFailure: { status: number; body: string } | { throws: Error } | undefined;
  /**
   * Each request to `/mcp`, in order: the bearer token it presented, and
   * whether it was refused with a 401.
   */
  readonly mcpBearers: { refused: boolean; token: string }[];
  /** While true, every request to `/mcp` is refused with a 401. */
  refuseAccessTokens: boolean;
  /**
   * Every access token issued so far is refused at `/mcp` from now on, as
   * a server that revoked them would refuse them; refresh tokens stay live.
   */
  revokeAccessTokens(): void;
  /** The access token each refresh issued, in order. */
  readonly refreshedAccessTokens: string[];
  /** An access token for `projectId` and `audience`, as a grant would issue. */
  issueAccessToken(projectId: string, audience: "mcp" | "api"): string;
  /** The client a refresh token was issued to, and for which project. */
  grantOf(
    refreshToken: string,
  ): { clientId: string; projectId: string; resource: string } | undefined;
}

export const FAKE_ORGANIZATION_ID = "018f0000-0000-7000-8000-00000000f001";

/** The slug the fake's `list_projects` answers unless `slugOf` is changed. */
export const fakeProjectSlug = (projectId: string) =>
  `project-${projectId.slice(-4)}`;

export function createFakeAuthorizationServer(
  origin = "https://rp.example",
): FakeAuthorizationServer {
  let counter = 0;
  const next = (prefix: string) => {
    counter += 1;
    return `${prefix}-${counter}`;
  };
  const codes = new Map<
    string,
    { clientId: string; projectId: string; resource: string }
  >();
  const refreshTokens = new Map<
    string,
    { clientId: string; projectId: string; resource: string; live: boolean }
  >();
  const accessTokens = new Map<
    string,
    { projectId: string; resource: string }
  >();
  const pending: ((landing: string) => void)[] = [];
  const revoked = new Set<string>();

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status,
    });

  function issue(
    grant: {
      clientId: string;
      projectId: string;
      resource: string;
    },
    issued: string[] = [],
  ) {
    const access = next("access");
    issued.push(access);
    const refresh = next("refresh");
    accessTokens.set(access, {
      projectId: grant.projectId,
      resource: grant.resource,
    });
    refreshTokens.set(refresh, { ...grant, live: true });
    return json(200, {
      access_token: access,
      expires_in: 900,
      refresh_token: refresh,
      token_type: "Bearer",
    });
  }

  /** `/mcp`: a JSON-RPC message answered as a stateless server answers it. */
  function mcp(init: RequestInit | undefined): Response {
    const method = init?.method ?? "GET";
    if (method !== "POST") return new Response(null, { status: 405 });
    const headers = new Headers(init?.headers);
    const presented = (headers.get("authorization") ?? "").replace(
      /^Bearer /u,
      "",
    );
    const token = accessTokens.get(presented);
    if (
      token === undefined ||
      token.resource !== `${origin}/mcp` ||
      server.refuseAccessTokens ||
      revoked.has(presented)
    ) {
      server.mcpBearers.push({ refused: true, token: presented });
      return json(401, { error: "invalid_token" });
    }
    server.mcpBearers.push({ refused: false, token: presented });
    const message = JSON.parse(String(init?.body)) as {
      id?: number;
      method?: string;
      params?: { name?: string; protocolVersion?: string };
    };
    server.mcpMessages.push({
      method: message.method ?? "(response)",
      protocolVersion: headers.get("mcp-protocol-version"),
    });
    const failure = server.mcpFailure;
    if (failure !== undefined && message.method !== "initialize") {
      if ("throws" in failure) throw failure.throws;
      return new Response(failure.body, { status: failure.status });
    }
    if (message.id === undefined) return new Response(null, { status: 202 });
    const answer = (result: unknown) =>
      json(200, { id: message.id, jsonrpc: "2.0", result });
    const tool = (structuredContent: Record<string, unknown>) =>
      answer({
        content: [{ text: JSON.stringify(structuredContent), type: "text" }],
        structuredContent,
      });
    if (message.method === "initialize") {
      return answer({
        capabilities: { tools: {} },
        protocolVersion: message.params?.protocolVersion,
        serverInfo: { name: "fake", version: "1.0.0" },
      });
    }
    if (message.method === "tools/list") {
      return answer({
        tools: [
          { inputSchema: { type: "object" }, name: "whoami" },
          { inputSchema: { type: "object" }, name: "list_projects" },
        ],
      });
    }
    const name = message.params?.name ?? "";
    server.mcpCalls.push(name);
    if (message.method === "tools/call" && name === "whoami") {
      return tool({
        audience: "mcp",
        organizationId: FAKE_ORGANIZATION_ID,
        projectId: token.projectId,
        scopes: [...server.mcpScopes],
      });
    }
    if (message.method === "tools/call" && name === "list_projects") {
      return tool({
        items: [{ id: token.projectId, slug: server.slugOf(token.projectId) }],
      });
    }
    return json(200, {
      error: { code: -32601, message: "not found" },
      id: message.id,
      jsonrpc: "2.0",
    });
  }

  const server: FakeAuthorizationServer = {
    grants: [],
    mcpBearers: [],
    mcpCalls: [],
    mcpFailure: undefined,
    mcpMessages: [],
    mcpScopes: [...AGENT_SCOPES],
    origin,
    refreshedAccessTokens: [],
    refreshes: [],
    refuseAccessTokens: false,
    refuseRefreshes: false,
    registrations: [],
    sendIssuer: true,
    slugOf: fakeProjectSlug,

    revokeAccessTokens() {
      for (const token of accessTokens.keys()) revoked.add(token);
    },

    consent(url, projectId) {
      const request = new URL(url);
      const chosen = projectId ?? server.grants.shift();
      if (chosen === undefined) throw new Error("no project to consent to");
      const code = next("code");
      codes.set(code, {
        clientId: request.searchParams.get("client_id") ?? "",
        projectId: chosen,
        resource: request.searchParams.get("resource") ?? "",
      });
      const landing = new URL(request.searchParams.get("redirect_uri") ?? "");
      landing.searchParams.set("code", code);
      landing.searchParams.set(
        "state",
        request.searchParams.get("state") ?? "",
      );
      if (server.sendIssuer) landing.searchParams.set("iss", origin);
      const settle = pending.shift();
      if (settle === undefined) throw new Error("no receiver is waiting");
      settle(landing.toString());
    },

    async fetch(url, init) {
      const target = new URL(url);
      const method = init?.method ?? "GET";
      if (target.origin !== origin) return json(404, { error: "not_found" });
      if (target.pathname === "/mcp") return mcp(init);

      if (
        method === "GET" &&
        target.pathname === "/.well-known/oauth-authorization-server"
      ) {
        return json(200, {
          authorization_endpoint: `${origin}/api/auth/oauth2/authorize`,
          authorization_response_iss_parameter_supported: true,
          code_challenge_methods_supported: ["S256"],
          issuer: origin,
          registration_endpoint: `${origin}/api/auth/oauth2/register`,
          token_endpoint: `${origin}/api/auth/oauth2/token`,
        });
      }
      if (
        method === "POST" &&
        target.pathname === "/api/auth/oauth2/register"
      ) {
        const clientId = next("client");
        server.registrations.push(clientId);
        return json(201, { client_id: clientId });
      }
      if (method === "POST" && target.pathname === "/api/auth/oauth2/token") {
        const form = new URLSearchParams(String(init?.body ?? ""));
        if (form.get("grant_type") === "authorization_code") {
          const grant = codes.get(form.get("code") ?? "");
          codes.delete(form.get("code") ?? "");
          if (grant === undefined || grant.clientId !== form.get("client_id")) {
            return json(400, { error: "invalid_grant" });
          }
          return issue(grant);
        }
        if (form.get("grant_type") === "refresh_token") {
          const presented = form.get("refresh_token") ?? "";
          const clientId = form.get("client_id") ?? "";
          server.refreshes.push({ clientId, refreshToken: presented });
          const grant = refreshTokens.get(presented);
          if (
            server.refuseRefreshes ||
            grant === undefined ||
            !grant.live ||
            grant.clientId !== clientId ||
            grant.resource !== form.get("resource")
          ) {
            return json(400, { error: "invalid_grant" });
          }
          grant.live = false;
          return issue(grant, server.refreshedAccessTokens);
        }
        return json(400, { error: "unsupported_grant_type" });
      }
      if (method === "GET" && target.pathname === "/api/v1/whoami") {
        const header = new Headers(init?.headers).get("authorization") ?? "";
        const token = accessTokens.get(header.replace(/^Bearer /u, ""));
        if (token === undefined || token.resource !== `${origin}/api/v1`) {
          return json(401, { error: "unauthorized" });
        }
        return json(200, {
          actor: { id: "018f0000-0000-7000-8000-00000000f002", type: "agent" },
          audience: "api",
          authorizationId: "fake-authorization",
          laneIds: [],
          organizationId: FAKE_ORGANIZATION_ID,
          projectId: token.projectId,
          scopes: [],
          serverSchemaVersion: 1,
          workPolicy: {},
        });
      }
      return json(404, { error: "not_found" });
    },

    issueAccessToken(projectId, audience) {
      const access = next("access");
      accessTokens.set(access, {
        projectId,
        resource: `${origin}${audience === "mcp" ? "/mcp" : "/api/v1"}`,
      });
      return access;
    },

    grantOf(refreshToken) {
      const grant = refreshTokens.get(refreshToken);
      return grant === undefined
        ? undefined
        : {
            clientId: grant.clientId,
            projectId: grant.projectId,
            resource: grant.resource,
          };
    },

    startCallbackReceiver() {
      let settle: (landing: string) => void = () => {};
      const callback = new Promise<string>((resolve) => {
        settle = resolve;
      });
      pending.push((landing) => settle(landing));
      return {
        callback,
        close: () => {},
        redirectUri: "http://127.0.0.1:49152/callback",
      };
    },
  };
  return server;
}

/**
 * `whoami` against the fake: MCP's answered from the grant behind the held
 * refresh token, after a token source over the holding store has refreshed
 * once, as the real `askWhoami` does before it calls the tool; REST's through
 * the real `askWhoami`, which the fake's `fetch` answers. `lockDirectories`
 * records the directory each call was given.
 */
export function fakeWhoami(server: FakeAuthorizationServer): {
  readonly lockDirectories: string[];
  readonly whoami: AskWhoami;
} {
  const lockDirectories: string[] = [];
  return {
    lockDirectories,
    whoami: async (input) => {
      lockDirectories.push(input.lockDirectory);
      if (input.audience === "api") return askWhoami(input);
      await createTokenSource({
        audience: "mcp",
        fetch: server.fetch,
        lockDirectory: input.lockDirectory,
        projectId: HOLDING_PROJECT_ID,
        server: input.server,
        store: input.holding,
      }).accessToken();
      const grant = server.grantOf(input.holding.held()?.refreshToken ?? "");
      return {
        organizationId: FAKE_ORGANIZATION_ID,
        projectId: grant?.projectId ?? null,
      };
    },
  };
}
