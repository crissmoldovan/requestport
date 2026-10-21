import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  type Audience,
  CREDENTIAL_DIRECTORY,
  type CredentialStore,
  resourceFor,
  type StoredCredential,
} from "./credentials.js";
import { acquireLock, releaseLock } from "./lock.js";
import {
  type AuthorizationServerMetadata,
  discover,
  type FetchLike,
  OAuthError,
  refresh,
  TokenRequestError,
  type TokenResponse,
} from "./oauth.js";

export { LockTimeoutError } from "./lock.js";

/**
 * How long one request to the server may take before it is aborted: the
 * refresh, and the discovery before it. A third of `LOCK_STALE_AFTER_MS`, so
 * a running holder's refresh has ended, by answer or by abort, long before
 * another process may take its lock over (manifest-h.md §2.8.2). Otherwise a
 * slow token endpoint would let a second process present the same refresh
 * token, and the provider revokes the whole authorization when a rotated
 * token is presented.
 */
export const REFRESH_TIMEOUT_MS = 20_000;

/** A lock older than this is taken over even from a running holder. */
export const LOCK_STALE_AFTER_MS = 60_000;

/** How long a source waits for another to finish refreshing. */
export const LOCK_WAIT_MS = 30_000;

/** An access token is refreshed this long before it expires. */
export const EXPIRY_MARGIN_MS = 60_000;

export type AuthorizationRequiredReason =
  /** Nothing is stored for this server, project and audience. */
  | "missing"
  /** Only a record the client before version 2 stored, which has no client id. */
  | "earlier-client"
  /** The server refused the stored credential (`invalid_grant`); it was removed. */
  | "refused";

/**
 * The person has to authorize again. The message names the server, the
 * project, the audience and the command that does it.
 */
export class AuthorizationRequiredError extends Error {
  readonly audience: Audience;
  readonly reason: AuthorizationRequiredReason;

  constructor(
    message: string,
    audience: Audience,
    reason: AuthorizationRequiredReason,
  ) {
    super(message);
    this.name = "AuthorizationRequiredError";
    this.audience = audience;
    this.reason = reason;
  }
}

/**
 * A refresh that did not complete, for a reason that may pass: the server
 * did not answer in time, could not be reached, or refused for a reason
 * other than `invalid_grant`. The stored credential is kept.
 */
export class TokenRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenRefreshError";
  }
}

export interface TokenSourceOptions {
  readonly audience: Audience;
  readonly fetch?: FetchLike;
  /** Where the locks are kept; `~/.requestport/locks` unless given. */
  readonly lockDirectory?: string;
  /** Milliseconds since the epoch, for the access token's expiry. */
  readonly now?: () => number;
  readonly projectId: string;
  readonly server: string;
  readonly store: CredentialStore;
}

/**
 * Access tokens for one server, project and audience, refreshed from the
 * stored credential. Nothing on it carries the refresh token.
 */
export interface TokenSource {
  accessToken(): Promise<string>;
  /**
   * Drops the access token kept in memory, so the next `accessToken()`
   * refreshes: for a server that refused it (an HTTP 401) before it expired
   * (r9-rulings.md, ruling 102). A refresh already under way is not
   * affected: calls made meanwhile share it, and its token is kept.
   * Every source `createTokenSource` makes has it; a source that hands out a
   * fixed token has nothing to refresh and leaves it out.
   */
  forgetAccessToken?(): void;
}

/**
 * Longer than any errno symbol (POSIX's longest, `EPROTONOSUPPORT`, has
 * fifteen characters), so a longer run of capitals is not one.
 */
const ERRNO_MAX_LENGTH = 20;

/**
 * The one thing a foreign error may add to a message: an errno symbol, on
 * the error or its cause, which is a word from a fixed set. The error's own
 * message may quote the request, and a refresh request's body is the token.
 */
function errnoOf(error: unknown): string {
  for (const candidate of [error, (error as { cause?: unknown })?.cause]) {
    const code =
      typeof candidate === "object" && candidate !== null
        ? (candidate as { code?: unknown }).code
        : undefined;
    if (
      typeof code === "string" &&
      code.length <= ERRNO_MAX_LENGTH &&
      /^[A-Z][A-Z0-9_]*$/u.test(code)
    ) {
      return ` (${code})`;
    }
  }
  return "";
}

/** The reason a request was aborted at the bound, told apart from others. */
class Expired extends Error {}

function withSignal(fetch: FetchLike, signal: AbortSignal): FetchLike {
  return (url, init) => fetch(url, { ...init, signal });
}

/**
 * Run one request, aborting it at `REFRESH_TIMEOUT_MS`. The signal reaches
 * the fetch, and the request is also raced against the bound, so a fetch
 * that ignores its signal is given up on all the same.
 */
async function bounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const expired = new Expired();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(expired);
      reject(expired);
    }, REFRESH_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * manifest-h.md §2.8.2's token source.
 *
 * 1. An access token is kept in memory until `EXPIRY_MARGIN_MS` before its
 *    `expires_in`, or until `forgetAccessToken()` drops it. One without an
 *    `expires_in` is not kept.
 * 2. Otherwise it takes an exclusive lock for this server, project and
 *    audience (`<lockDirectory>/<sha256 of the three>.lock`, `lock.ts`),
 *    waiting up to `LOCK_WAIT_MS`.
 * 3. Under the lock it reads the credential again, because another process
 *    may have rotated it while this one waited; refreshes with the stored
 *    client id and resource, the request aborted at `REFRESH_TIMEOUT_MS`;
 *    and writes the rotated refresh token before it releases the lock and
 *    before it returns the access token. Aborted, or failed for any reason
 *    but `invalid_grant`, it keeps the stored record: after an abort,
 *    whether the server rotated it is not known.
 * 4. On `invalid_grant` it removes the credential and throws an
 *    `AuthorizationRequiredError` naming the command. It does not retry.
 *
 * The server is discovered before the lock is taken (once per source, and
 * again only after a discovery that failed), so the only request ever made
 * while holding the lock is the bounded refresh.
 *
 * Under the lock it reads the store once, refreshes, and writes the store
 * once. The refresh is aborted at `REFRESH_TIMEOUT_MS`. The keychain store
 * kills each `security` call at `KEYCHAIN_COMMAND_TIMEOUT_MS`, and a refresh
 * makes three (the read, and the write's removal of the earlier client's
 * item and its add): 10 + 20 + 10 + 10 = 50 s. The file store reads and
 * writes one local file, and its write waits at most 15 s for that file's
 * writers' lock: 35 s and the file operations. Both are under
 * `LOCK_STALE_AFTER_MS`, after which another process may take the lock
 * over. The sums count this source's own steps only. The store's calls are
 * synchronous (`spawnSync`, and the file store's `Atomics.wait`) and block
 * the whole thread, so other synchronous work in the holder's own process
 * between its steps lengthens the hold: another token source's `security`
 * calls, or its wait for the file store's writers' lock. A holder kept past
 * that age that way, or suspended past it (stopped, or on a machine that
 * slept), is the case these bounds do not cover: another process may then
 * take the lock over and present the refresh token this one is rotating.
 */
export function createTokenSource(options: TokenSourceOptions): TokenSource {
  const { audience, projectId, server, store } = options;
  const fetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;

  // Composed now, so a server that is not a URL or an audience that is not
  // one of the two is refused when the source is made.
  const resource = resourceFor(server, audience);
  const origin = new URL(resource).origin;
  const lockPath = join(
    options.lockDirectory ?? join(homedir(), CREDENTIAL_DIRECTORY, "locks"),
    `${createHash("sha256")
      .update(JSON.stringify([origin, projectId, audience]))
      .digest("hex")}.lock`,
  );
  const which = `the ${audience} credential for project ${projectId} on ${origin}`;
  const login = `run "requestport login --for ${audience}"`;

  let metadata: AuthorizationServerMetadata | undefined;
  let cached:
    | { readonly expiresAt: number; readonly token: string }
    | undefined;
  let inFlight: Promise<string> | undefined;

  function authorizationRequired(): AuthorizationRequiredError {
    let earlier = false;
    try {
      earlier = store.hasLegacyRecord(server, projectId);
    } catch {
      // Unanswerable is reported as missing: either way the remedy is the same.
    }

    return earlier
      ? new AuthorizationRequiredError(
          `Authorization required: the credential stored for project ${projectId} on ${origin} was stored by an earlier client without its registration, so it cannot be refreshed. To authorize again, ${login}.`,
          audience,
          "earlier-client",
        )
      : new AuthorizationRequiredError(
          `Authorization required: no ${audience} credential is stored for project ${projectId} on ${origin}. To authorize, ${login}.`,
          audience,
          "missing",
        );
  }

  function failed(error: unknown, doing: string): Error {
    if (error instanceof Expired) {
      return new TokenRefreshError(
        `Could not ${doing} ${which}: ${origin} did not answer within ${REFRESH_TIMEOUT_MS / 1000}s. The stored credential is kept, because whether the server rotated it is not known.`,
      );
    }
    if (error instanceof OAuthError) {
      // This package's own message: an endpoint, a status and a code, never a value.
      return new TokenRefreshError(
        `Could not ${doing} ${which}. ${error.message} The stored credential is kept.`,
      );
    }
    return new TokenRefreshError(
      `Could not ${doing} ${which}: ${origin} could not be reached${errnoOf(error)}. The stored credential is kept.`,
    );
  }

  async function discovered(): Promise<AuthorizationServerMetadata> {
    if (metadata !== undefined) return metadata;
    try {
      metadata = await bounded((signal) =>
        discover(server, withSignal(fetch, signal)),
      );
    } catch (error) {
      throw failed(error, "discover the token endpoint for");
    }
    return metadata;
  }

  async function refreshed(
    record: StoredCredential,
    found: AuthorizationServerMetadata,
  ): Promise<TokenResponse> {
    try {
      return await bounded((signal) =>
        refresh(
          {
            clientId: record.clientId,
            metadata: found,
            refreshToken: record.refreshToken,
            resource: record.resource,
          },
          withSignal(fetch, signal),
        ),
      );
    } catch (error) {
      if (
        error instanceof TokenRequestError &&
        error.error === "invalid_grant"
      ) {
        try {
          store.clear(server, projectId, audience);
        } catch {
          // The record is dead either way; the next use is refused again.
        }
        throw new AuthorizationRequiredError(
          `Authorization required again: ${origin} refused ${which} (invalid_grant), so it has been removed. To authorize again, ${login}.`,
          audience,
          "refused",
        );
      }
      throw failed(error, "refresh");
    }
  }

  async function obtain(): Promise<string> {
    // Nothing stored is answered without a request and without the lock.
    if (store.read(server, projectId, audience) === undefined) {
      throw authorizationRequired();
    }
    const found = await discovered();

    const lock = await acquireLock(lockPath, {
      staleAfterMs: LOCK_STALE_AFTER_MS,
      waitMs: LOCK_WAIT_MS,
    });
    try {
      const record = store.read(server, projectId, audience);
      if (record === undefined) throw authorizationRequired();

      const tokens = await refreshed(record, found);
      if (tokens.refresh_token !== undefined) {
        store.write(server, projectId, audience, {
          ...record,
          refreshToken: tokens.refresh_token,
        });
      }

      cached =
        tokens.expires_in === undefined
          ? undefined
          : {
              expiresAt: now() + tokens.expires_in * 1000,
              token: tokens.access_token,
            };
      return tokens.access_token;
    } finally {
      releaseLock(lock);
    }
  }

  return {
    accessToken() {
      if (cached !== undefined && now() < cached.expiresAt - EXPIRY_MARGIN_MS) {
        return Promise.resolve(cached.token);
      }

      // Calls made while a refresh is under way share it.
      inFlight ??= obtain().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    forgetAccessToken() {
      cached = undefined;
    },
  };
}
