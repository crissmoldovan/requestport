import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import type { FetchLike } from "../oauth.js";

export const TOKEN_PATH = "/api/auth/oauth2/token";

/** One refresh request, as the token endpoint received it. */
export type Exchange = {
  readonly clientId: string | null;
  readonly refreshToken: string | null;
  readonly resource: string | null;
};

type Family = {
  readonly clientId: string;
  readonly projectId: string;
  readonly resource: string;
  revoked: boolean;
};

type Answer = { readonly body: unknown; readonly status: number };

type Incoming = {
  readonly authorization: string | null;
  readonly body: string;
  readonly method: string;
  readonly signal: AbortSignal | undefined;
  readonly url: string;
};

export type FakeProvider = {
  /** Answers as the server would, without a socket. */
  readonly fetch: FetchLike;
  readonly issuer: string;
  /** A refresh token from a new authorization of this client, for a resource. */
  authorize(options: {
    readonly clientId: string;
    readonly projectId: string;
    readonly resource: string;
  }): string;
  /** Whether the server would honour this access token now, at `resource`. */
  accepts(accessToken: string, resource: string): boolean;
  /** Every refresh received, in order. */
  readonly refreshes: Exchange[];
  /** How many authorizations were revoked whole for a reused refresh token. */
  familiesRevoked(): number;
  /** The most refreshes ever being answered at one moment. */
  mostInFlight(): number;
  /** The most refreshes of one token ever being answered at one moment. */
  mostInFlightForOneToken(): number;
  /**
   * Run before a refresh is answered. It may delay the answer or never let
   * it come; a request whose caller aborts stops being in flight then.
   */
  hold:
    | ((exchange: Exchange, signal: AbortSignal | undefined) => Promise<void>)
    | undefined;
  handle(incoming: Incoming): Promise<Answer>;
};

function token(prefix: string): string {
  return `${prefix}-${randomBytes(9).toString("base64url")}`;
}

/**
 * Wait for `ms`, or reject as a fetch does when its signal aborts.
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

/** Never resolves; rejects with the signal's reason when it aborts. */
export function never(signal?: AbortSignal): Promise<void> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason));
  });
}

/**
 * A stand-in for RequestPort's authorization server and its REST `whoami`,
 * faithful where the token source's correctness depends on it: the refresh
 * grant as `@better-auth/oauth-provider` 1.7.6 answers it (manifest-h.md
 * §1.6, read there in `introspect-CbYi2MJT.mjs`).
 *
 * - A refresh token is bound to its client: one presented by another client
 *   id is refused `invalid_grant`.
 * - Every refresh rotates: the token presented is spent, and a new one is
 *   issued with a new access token.
 * - A spent token presented again revokes the whole authorization, every
 *   refresh and access token minted from it, and is refused `invalid_grant`:
 *   the reuse interval is 0.
 *
 * An access token is honoured only at the resource its authorization names,
 * and only while that authorization stands.
 */
export function createFakeProvider(issuer: string): FakeProvider {
  const refreshTokens = new Map<string, { family: Family; spent: boolean }>();
  const accessTokens = new Map<string, Family>();
  const refreshes: Exchange[] = [];
  const inFlight = new Map<string, number>();
  let current = 0;
  let mostInFlight = 0;
  let mostForOne = 0;
  let familiesRevoked = 0;

  const metadata = {
    authorization_endpoint: `${issuer}/api/auth/oauth2/authorize`,
    authorization_response_iss_parameter_supported: true,
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    issuer,
    registration_endpoint: `${issuer}/api/auth/oauth2/register`,
    response_types_supported: ["code"],
    token_endpoint: `${issuer}${TOKEN_PATH}`,
  };

  function refused(error: string, status = 400): Answer {
    return { body: { error, error_description: "refused" }, status };
  }

  function rotate(exchange: Exchange): Answer {
    const held =
      exchange.refreshToken === null
        ? undefined
        : refreshTokens.get(exchange.refreshToken);
    if (held === undefined) return refused("invalid_grant");
    if (held.family.clientId !== exchange.clientId) {
      return refused("invalid_grant");
    }
    if (
      exchange.resource !== null &&
      exchange.resource !== held.family.resource
    ) {
      return refused("invalid_target");
    }
    if (held.spent || held.family.revoked) {
      if (!held.family.revoked) familiesRevoked += 1;
      held.family.revoked = true;
      return refused("invalid_grant");
    }

    held.spent = true;
    const refreshToken = token("rt");
    const accessToken = token("at");
    refreshTokens.set(refreshToken, { family: held.family, spent: false });
    accessTokens.set(accessToken, held.family);

    return {
      body: {
        access_token: accessToken,
        expires_in: 900,
        refresh_token: refreshToken,
        token_type: "Bearer",
      },
      status: 200,
    };
  }

  const provider: FakeProvider = {
    accepts(accessToken, resource) {
      const family = accessTokens.get(accessToken);
      return (
        family !== undefined && !family.revoked && family.resource === resource
      );
    },
    authorize({ clientId, projectId, resource }) {
      const refreshToken = token("rt");
      refreshTokens.set(refreshToken, {
        family: { clientId, projectId, resource, revoked: false },
        spent: false,
      });
      return refreshToken;
    },
    familiesRevoked: () => familiesRevoked,
    fetch: async (url, init) => {
      const answer = await provider.handle({
        authorization: new Headers(init?.headers).get("authorization"),
        body: typeof init?.body === "string" ? init.body : "",
        method: init?.method ?? "GET",
        signal: init?.signal ?? undefined,
        url,
      });
      return new Response(JSON.stringify(answer.body), {
        headers: { "content-type": "application/json" },
        status: answer.status,
      });
    },
    async handle({ authorization, body, method, signal, url }) {
      const path = url.startsWith(issuer) ? url.slice(issuer.length) : url;

      if (
        method === "GET" &&
        path === "/.well-known/oauth-authorization-server"
      ) {
        return { body: metadata, status: 200 };
      }

      if (method === "POST" && path === TOKEN_PATH) {
        const form = new URLSearchParams(body);
        if (form.get("grant_type") !== "refresh_token") {
          return refused("unsupported_grant_type");
        }
        const exchange: Exchange = {
          clientId: form.get("client_id"),
          refreshToken: form.get("refresh_token"),
          resource: form.get("resource"),
        };
        refreshes.push(exchange);

        const key = exchange.refreshToken ?? "";
        current += 1;
        inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
        mostInFlight = Math.max(mostInFlight, current);
        mostForOne = Math.max(mostForOne, inFlight.get(key) ?? 0);
        try {
          await provider.hold?.(exchange, signal);
          return rotate(exchange);
        } finally {
          current -= 1;
          inFlight.set(key, (inFlight.get(key) ?? 1) - 1);
        }
      }

      if (method === "GET" && path === "/api/v1/whoami") {
        const bearer = authorization?.replace(/^Bearer /u, "") ?? "";
        const family = accessTokens.get(bearer);
        if (
          family === undefined ||
          !provider.accepts(bearer, `${issuer}/api/v1`)
        ) {
          return {
            body: {
              details: {},
              error: "unauthenticated",
              message: "A valid agent credential is required.",
            },
            status: 401,
          };
        }
        return {
          body: {
            actor: { id: "agent-1", type: "agent" },
            audience: "api",
            authorizationId: "authorization-1",
            laneIds: [],
            organizationId: "c533d303-b467-421d-bb76-bef05608d496",
            projectId: family.projectId,
            scopes: ["request:read"],
            serverSchemaVersion: 1,
            workPolicy: { heartbeatIntervalSeconds: 60 },
          },
          status: 200,
        };
      }

      return {
        body: { error: "not_found", message: "Not found." },
        status: 404,
      };
    },
    hold: undefined,
    issuer,
    mostInFlight: () => mostInFlight,
    mostInFlightForOneToken: () => mostForOne,
    refreshes,
  };

  return provider;
}

/**
 * The same provider behind a real socket on 127.0.0.1, for a child process
 * to reach. A request whose client goes away stops being in flight then.
 */
export async function serveFakeProvider(): Promise<{
  close(): Promise<void>;
  provider: FakeProvider;
}> {
  let provider: FakeProvider | undefined;

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    const gone = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) gone.abort();
    });
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const incoming: Incoming = {
        authorization: request.headers.authorization ?? null,
        body: Buffer.concat(chunks).toString("utf8"),
        method: request.method ?? "GET",
        signal: gone.signal,
        url: `${provider?.issuer ?? ""}${request.url ?? "/"}`,
      };
      (provider as FakeProvider).handle(incoming).then(
        ({ body, status }) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(body));
        },
        () => response.destroy(),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  provider = createFakeProvider(`http://127.0.0.1:${port}`);

  return {
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    provider,
  };
}
