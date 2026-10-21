import {
  type Audience,
  type CredentialStore,
  CredentialStoreError,
  isAudience,
  resourceFor,
} from "./credentials.js";
import {
  buildAuthorizationUrl,
  createPkce,
  createState,
  discover,
  exchangeCode,
  type FetchLike,
  OAuthError,
  type Pkce,
  REFRESH_SCOPE,
  readCallback,
  registerClient,
} from "./oauth.js";

/**
 * The one path from "no credential" to "a credential", assembled out of the
 * primitives in `oauth.ts`.
 *
 * Each of those primitives is careful about one thing and none of them knows
 * the order. That order is its own correctness problem and this is the file
 * that owns it: the listener has to be bound before the client is registered,
 * because registration declares the redirect uri and nothing knows the port
 * until something is listening on it; the state has to exist before the url is
 * built and survive until the callback is read; and every step in between can
 * fail with a socket still open.
 *
 * Every side effect arrives as a parameter — the receiver, the browser, the
 * clock, the store, `fetch`. Not for tidiness: it is what lets an authorization
 * flow be tested with no network, no browser and no bound port, which is the
 * only way this suite runs on a plane, in CI, and twice in the same second.
 *
 * The name below is where the sequence starts, and the only part of it a
 * developer ever reads: it is what the consent screen says they are granting
 * to, so it names the agent rather than whichever tool happened to spawn it.
 */
export const AGENT_CLIENT_NAME = "requestport-agent";

/**
 * Raised only for a failure this module is the first to know about.
 *
 * `oauth.ts` and `credentials.ts` have their own error types, and those are
 * passed through untouched: they are written to the rule that a message carries
 * an endpoint, a status or a field name and never a value, and their own suites
 * hold them to it. Anything else that reaches this file came from code that has
 * made no such promise, so it is replaced by one of these rather than wrapped.
 */
export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

/**
 * The loopback listener, described by what this flow needs from it.
 *
 * It reports its own `redirectUri` rather than a port, because the path is the
 * receiver's business and the redirect uri registered with the server has to be
 * the one the browser will actually be sent to, character for character — a
 * server matches it exactly. Composing one here out of a port would put the two
 * halves of that string in two different files.
 *
 * The type is declared here rather than imported so that this module depends on
 * the shape and not on the implementation, and so a test can satisfy it without
 * binding anything.
 */
export interface CallbackReceiver {
  /**
   * Resolves with the full url the browser landed on, query string and all.
   *
   * Rejecting it from `close()` — the honest answer for a listener shut down
   * mid-wait — is allowed, and needs no handler of the receiver's own: this
   * flow attaches one the moment it has the receiver, precisely so that a
   * rejection nobody is waiting for cannot become an unhandled one.
   */
  readonly callback: Promise<string>;
  /** Stop listening. Called once, on every path out, including the good one. */
  close(): void | Promise<void>;
  /** Where the browser will be sent, as bound, and on this machine. */
  readonly redirectUri: string;
}

export interface AuthorizeDependencies {
  readonly fetch?: FetchLike;
  /**
   * An ISO timestamp. Injected because the stored credential carries one, and a
   * test that cannot say what time it is cannot assert what was written.
   */
  readonly now?: () => string;
  /**
   * The flow's own two secrets, injectable for the same reason `now` is.
   *
   * A test cannot assert that a secret never escaped unless it knows what the
   * secret was. The leak assertions used to recover the verifier by hashing
   * candidates against the `code_challenge` in the published authorization url,
   * which works only once that url exists — so on every path that fails before
   * publication the assertion silently checked nothing. An audit proved it by
   * leaking a live verifier into an early error and watching the suite stay
   * green.
   *
   * Production never passes these; the defaults are the real generators.
   */
  readonly pkce?: () => Pkce;
  readonly state?: () => string;
  /**
   * Where the authorization url goes so that a person can open it.
   *
   * There is no default, deliberately. This url is the only way anyone can
   * finish the flow, and a default that quietly dropped it would turn a machine
   * with no browser into a process waiting forever for a callback that nobody
   * could have triggered. Nothing in this package prints — the caller owns the
   * terminal — so the type is the only place that insistence can live.
   */
  readonly onAuthorizationUrl: (url: string) => void | Promise<void>;
  /**
   * Optional, because opening a browser is neither portable nor always
   * possible, and this package spawns nothing. Absent means "there is no
   * browser here", which is an ordinary answer on a container, a build agent or
   * an ssh session, and the url has already been handed over by then.
   */
  readonly openBrowser?: (url: string) => void | Promise<void>;
  readonly startCallbackReceiver: () =>
    | CallbackReceiver
    | Promise<CallbackReceiver>;
}

export interface AuthorizeOptions {
  /**
   * Which endpoint the credential is for: `mcp` for the bridge, `api` for the
   * HTTP client. Required, and the resource is derived from it and the
   * server, never taken as text: a consent that names no resource is
   * consented as MCP, so an `api` grant has to name its resource, and the
   * stored record has to hold it for every refresh (manifest-h.md §2.8.2).
   */
  readonly audience: Audience;
  readonly clientName?: string;
  readonly deps: AuthorizeDependencies;
  readonly projectId: string;
  readonly scopes: readonly string[];
  readonly server: string;
  readonly store: CredentialStore;
}

/**
 * What comes back carries no credential, the same as `resolve.ts`'s answer and
 * for the same reason: this value is the sort of thing that gets logged when an
 * agent starts, and a shape holding a token is one `JSON.stringify` from a log
 * line nobody meant to write. The access token is not returned either — it is
 * short-lived, and a caller that wants one asks a token source
 * (`token-source.ts`) at the moment it is used, which refreshes the stored
 * credential: the path every later call takes anyway. One path, and it is the
 * tested one.
 */
export type Authorization = Readonly<{ obtained: string }>;

/**
 * How long a word from that fixed alphabet is allowed to be.
 *
 * The alphabet on its own admits any run of capitals, and a long one is not a
 * symbol from a set someone could look up — it is an opaque value wearing the
 * right characters, which is what a credential looks like. The longest symbol
 * POSIX names is fifteen characters (`EPROTONOSUPPORT`), so twenty leaves room
 * for a platform's own without leaving room for a token. A code past it is
 * dropped and the message is one word poorer, which is the cheaper mistake.
 */
const ERRNO_MAX_LENGTH = 20;

/**
 * The only thing an error from outside this package may contribute to a message.
 *
 * `credentials.ts` applies the same rule and the two are written out separately
 * rather than shared, because what is being reused is the reason and not the
 * helper: an errno symbol is a word from a fixed alphabet and can be repeated,
 * while the error's own message cannot. A receiver's message quotes the request
 * it was reading, and that request is the callback carrying the code.
 */
function errorCode(error: unknown): string {
  const code =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;

  return typeof code === "string" &&
    code.length <= ERRNO_MAX_LENGTH &&
    /^[A-Z][A-Z0-9_]*$/u.test(code)
    ? ` (${code})`
    : "";
}

/**
 * Run an injected dependency, and let nothing of its own out if it fails.
 *
 * The alternative — attaching the original as `cause` — is the tidy-looking
 * refactor this exists to prevent. Node prints causes, so carrying one
 * discloses exactly as much as quoting it, and the failures here are the ones
 * most likely to be holding a live secret: a receiver failing mid-read has the
 * callback, a store failing mid-write has the refresh token.
 */
async function attempt<T>(
  what: string,
  work: () => T | Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (
      error instanceof AuthorizationError ||
      error instanceof CredentialStoreError ||
      error instanceof OAuthError
    ) {
      throw error;
    }

    throw new AuthorizationError(`${what}${errorCode(error)}.`);
  }
}

/**
 * The hosts that mean "this machine", which is the only place this flow's
 * browser may be sent.
 *
 * `oauth.ts` checks that a redirect uri is https anywhere or http on loopback,
 * which is the right rule for a redirect uri in general and too generous for
 * this one. The receiver reports the uri, the flow registers it, and the
 * browser is sent to it carrying the authorization code — so a receiver naming
 * a public host would put that code on someone else's server with every layer
 * below agreeing it was well formed. The set is the one `oauth.ts` already
 * names, so the two files cannot disagree about what loopback means.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

function assertLoopback(redirectUri: string): void {
  let host: string;
  try {
    host = new URL(redirectUri).hostname;
  } catch {
    throw new AuthorizationError(
      "The loopback receiver reported a redirect uri that is not an absolute url, so there is no telling where the browser would be sent.",
    );
  }

  if (LOOPBACK_HOSTS.has(host)) return;

  throw new AuthorizationError(
    `The loopback receiver reported ${redirectUri}, which is not on this machine. Refusing to register it or to open it: the browser would carry the authorization code to that host instead of back to this process.`,
  );
}

/**
 * Ask for the scope that makes the grant renewable.
 *
 * Without `offline_access` the server issues no refresh token, and a credential
 * with no refresh token is one this flow refuses to store — so requesting it is
 * not an extra capability slipped past the developer at the consent screen. It
 * grants access to nothing; it is a lifetime, and it is the lifetime this whole
 * module exists to produce. An empty request stays empty, so `oauth.ts` still
 * refuses that as the caller mistake it is rather than being handed a
 * one-scope grant nobody asked for.
 */
function renewable(scopes: readonly string[]): readonly string[] {
  if (scopes.length === 0 || scopes.includes(REFRESH_SCOPE)) return scopes;

  return [...scopes, REFRESH_SCOPE];
}

export async function authorize(
  options: AuthorizeOptions,
): Promise<Authorization> {
  const { audience, deps, projectId, scopes, server, store } = options;

  // Before anything is fetched or bound: without an audience there is no
  // resource to ask for, and no key to store the credential under.
  if (!isAudience(audience)) {
    throw new AuthorizationError(
      "An audience is required, mcp for the bridge or api for the HTTP client, so that the credential names its resource. Nothing was started.",
    );
  }

  const fetch = deps.fetch ?? globalThis.fetch;
  const requested = renewable(scopes);

  // First, and before anything is bound: a server that will not describe itself
  // is one this flow cannot finish, and there is no reason to have taken a port
  // and a browser tab to find that out.
  const metadata = await discover(server, fetch);
  const resource = resourceFor(server, audience);

  const receiver = await attempt(
    "The loopback receiver would not start, so there is nowhere for the authorization to be sent back to",
    () => deps.startCallbackReceiver(),
  );

  try {
    // Read once, and given a handler before anything else can fail.
    //
    // Every failure between here and the `attempt` that awaits it — a refused
    // registration, a redirect uri this flow will not use, a url that could not
    // be handed over — leaves this promise pending, and the `finally` then
    // closes a receiver which, like this package's own, rejects whatever it was
    // still waiting on. With nobody listening that is an unhandled rejection,
    // and Node answers one by printing the reason and killing the process: the
    // reason is the listener quoting the request it was mid-read on, which is
    // the callback carrying the code. The `attempt` below is what reports this
    // promise's failure; this only makes sure the failure is never nobody's.
    const arrival = receiver.callback;
    void arrival.catch(() => {});

    // Before the uri is registered, published or opened, because those are the
    // three ways it escapes this process.
    assertLoopback(receiver.redirectUri);

    const pkce = (deps.pkce ?? createPkce)();
    const state = (deps.state ?? createState)();

    const client = await registerClient(
      {
        clientName: options.clientName ?? AGENT_CLIENT_NAME,
        metadata,
        redirectUri: receiver.redirectUri,
        scopes: requested,
      },
      fetch,
    );

    const request = buildAuthorizationUrl({
      clientId: client.client_id,
      metadata,
      pkce,
      redirectUri: receiver.redirectUri,
      resource,
      scopes: requested,
      state,
    });

    // Handed over before the browser is tried, not after. An opener that hangs,
    // or that reports success having opened nothing, would otherwise leave the
    // person with no url and a process waiting on a callback.
    await attempt(
      "The authorization url could not be handed to the caller, so there is no way for anyone to authorize this",
      () => deps.onAuthorizationUrl(request.url),
    );

    // Started, not awaited. The url is already with the caller, so opening a
    // browser is a convenience — and awaiting an injected callback that never
    // settles wedged the whole flow with the listener still holding its port,
    // which is a worse failure than no browser at all. A headless machine, a
    // missing `open`, and a hung launcher now all end the same way: the person
    // pastes the url themselves.
    //
    // The rejection is swallowed and never reported, because this failure's
    // message is the one place in the flow where a `spawn` error would quote
    // the url — which carries the state — back into a log.
    void Promise.resolve()
      .then(() => deps.openBrowser?.(request.url))
      .catch(() => {});

    const landing = await attempt(
      "The authorization callback never arrived",
      () => arrival,
    );
    // RFC 9207 (ruling 20): the callback must name the issuer discovery found,
    // and must name one at all when the metadata promised it would.
    const { code } = readCallback(landing, {
      issuer: {
        identifier: metadata.issuer,
        required:
          metadata.authorization_response_iss_parameter_supported === true,
      },
      state,
    });

    const tokens = await exchangeCode(
      {
        clientId: client.client_id,
        code,
        metadata,
        redirectUri: receiver.redirectUri,
        resource,
        verifier: pkce.verifier,
      },
      fetch,
    );

    /**
     * The refusal this module is here to make.
     *
     * A credential with no refresh token works, once, for as long as the access
     * token lives — and then stops, in the middle of something, on a machine
     * where nobody is watching. Storing it hides that until it fails, at which
     * point the failure is a token expiry hours away from the authorization
     * that caused it. Refusing now costs one consent screen.
     */
    const refreshToken = tokens.refresh_token;
    if (refreshToken === undefined) {
      throw new AuthorizationError(
        `${server} issued no refresh token for project ${projectId}, so this credential would stop working at the first access-token expiry with nothing to renew it. Refusing to store it rather than storing a credential that fails later, elsewhere, for a reason nobody will connect to this moment.`,
      );
    }

    // Read once, so the timestamp written and the timestamp reported cannot
    // disagree about when this happened.
    const obtained =
      deps.now === undefined ? new Date().toISOString() : deps.now();

    // The whole record: the client id the registration returned, because a
    // refresh token is refreshed only by the client it was issued to, and the
    // resource, because each refresh must name it again.
    await attempt(
      `The ${audience} credential for project ${projectId} on ${server} could not be stored`,
      () =>
        store.write(server, projectId, audience, {
          audience,
          clientId: client.client_id,
          obtained,
          refreshToken,
          resource,
          version: 2,
        }),
    );

    return { obtained };
  } finally {
    try {
      await receiver.close();
    } catch {
      // A close that fails has nothing left to say, and letting it throw from a
      // `finally` would replace whatever brought us here — including a
      // successful return — with the tidying-up's own complaint.
    }
  }
}
