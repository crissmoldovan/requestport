import { createServer, type ServerResponse } from "node:http";

/**
 * Where the authorization code comes back to.
 *
 * The browser is the only party that ever sees the developer sign in, and the
 * authorization server's only way to hand the result back to a program on their
 * machine is to redirect the browser at it. So a CLI listens for one request,
 * takes the url the browser landed on, and stops.
 *
 * Everything below is written against the two properties that make that safe:
 * the listener is reachable only from this machine, and it lives exactly as
 * long as the one redirect it is waiting for.
 */

/**
 * Not an option, deliberately.
 *
 * RFC 8252 permits a public client to receive an authorization code over plain
 * http for one reason: on the loopback interface "the network" is this process
 * and the browser next to it. The same listener bound to 0.0.0.0 publishes a
 * port that accepts an authorization code from anyone who can reach the
 * machine, and no amount of PKCE downstream repairs that. A `host` option would
 * be a setting nobody has a good reason to change and somebody will.
 */
const LOOPBACK_HOST = "127.0.0.1";

/** Port 0 asks the kernel for a free one, which is why the bound port is read
 * back rather than assumed. */
const EPHEMERAL_PORT = 0;

export const DEFAULT_CALLBACK_PATH = "/callback";

/**
 * Long enough to find the browser window, read a consent screen and get through
 * an identity provider that wants a second factor. A deadline measured in
 * seconds reads to a developer as a broken CLI rather than as one they missed.
 */
export const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * The longest deadline a timer can actually hold.
 *
 * `setTimeout` counts milliseconds into a signed 32-bit integer, and node does
 * not refuse a bigger delay — it clamps it to 1ms and fires almost at once. A
 * caller asking to wait a week was told "no authorization callback arrived
 * within 604800000ms" seven milliseconds later, quoting a deadline nothing had
 * honoured. Refusing the argument says the same thing while it is still true.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * What the browser is shown, in full.
 *
 * A constant, and that is the point: this page is rendered by a browser, kept
 * in history, and photographed by whoever is standing behind the developer.
 * There is no template hole for the query to end up in, so it cannot.
 */
const DONE_PAGE = [
  "RequestPort has the authorization.",
  "",
  "You can close this tab and go back to your terminal.",
  "",
].join("\n");

const NOT_FOUND_PAGE = "Not found.\n";

export class CallbackServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CallbackServerError";
  }
}

export type CallbackServerOptions = {
  readonly path?: string;
  readonly port?: number;
  readonly timeoutMs?: number;
};

export type CallbackServer = {
  /** The interface the kernel says it is bound to, not the one we asked for. */
  readonly host: string;
  readonly path: string;
  readonly port: number;
  /** The full url the browser landed on, query intact, for `readCallback`. */
  readonly received: Promise<string>;
  readonly redirectUri: string;
  /** Stop waiting and close the socket. A no-op once the wait has ended. */
  close(): void;
};

/**
 * A redirect uri is registered with the authorization server before the flow
 * starts and compared to the letter afterwards, so a path carrying its own
 * query or fragment is a mismatch discovered at the redirect — the one moment
 * there is no way left to explain it to the developer.
 */
function assertCallbackPath(path: string): void {
  if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
    throw new CallbackServerError(
      `The callback path ${JSON.stringify(path)} must be an absolute path with no query or fragment.`,
    );
  }
}

function assertTimeout(timeoutMs: number): void {
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new CallbackServerError(
      `The callback timeout must be a positive number of milliseconds no greater than ${MAX_TIMEOUT_MS}, and ${timeoutMs} is not. A listener with no deadline is one a cancelled sign-in leaves holding a port, and a deadline no timer can hold is one that fires at once and blames the browser for it.`,
    );
  }
}

/**
 * Every response says `close`, because this server answers at most one useful
 * request and then wants its socket back. Without it the browser keeps the
 * connection alive and the process stays up holding a socket nobody is waiting
 * on any more.
 */
function respond(
  response: ServerResponse,
  status: number,
  body: string,
  flushed?: () => void,
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    connection: "close",
    "content-type": "text/plain; charset=utf-8",
  });
  response.end(body, flushed);
}

/**
 * The request target, or nothing when it cannot be understood.
 *
 * A function rather than an inline `try` so the throw cannot be reintroduced by
 * editing the guard: a caller has to deal with `undefined`, where an inline
 * `new URL` merely looks total until a malformed target arrives.
 */
function parseTarget(
  url: string | undefined,
  origin: string | undefined,
): URL | undefined {
  // No origin means the socket has not reported its address yet, so there is
  // nothing to resolve a relative target against and nothing this listener
  // could honestly claim a request was addressed to.
  if (origin === undefined) return undefined;

  try {
    return new URL(url ?? "/", origin);
  } catch {
    return undefined;
  }
}

/**
 * Whether this request is the redirect, or something else that found the port.
 *
 * The origin check cannot help here, and no check of the connection can. When a
 * page in another tab makes the browser fetch `http://127.0.0.1:<port>/callback`
 * the browser really does connect to this listener, from this machine, and the
 * request is indistinguishable at the socket from the one the sign-in is
 * waiting for. What that page has no way to produce is the *content* of an
 * authorization response: the redirect always carries `code`, or `error` when
 * the person said no (RFC 6749 §4.1.2 and §4.1.2.1). A request with neither is
 * not a redirect from an authorization server, whoever sent it.
 *
 * So a bare `GET /callback` gets a 404 and the wait goes on, which is the safer
 * of the two mistakes on offer. A 404 costs a genuinely malformed redirect one
 * plain page and a wait that ends at its own deadline. Being permissive costs
 * every sign-in that shares a machine with an open browser tab: a stray request
 * spends the single use, the real redirect arrives to a closed port, and the
 * developer is shown a state-mismatch failure that has nothing to do with what
 * happened.
 *
 * This is not a defence against a page that is trying — one that guesses the
 * port can add `?code=x` just as cheaply — and it is not meant to be; the state
 * check in `readCallback` is what makes such a request worthless. It takes away
 * the case where a request that is not even aimed at us, a prefetch or a port
 * scan from another tab, silently ends a sign-in.
 *
 * Empty counts as absent, because `readCallback` reads `code=` as no code:
 * accepting what the reader will refuse spends the single use for nothing.
 */
function looksLikeAuthorizationResponse(target: URL): boolean {
  for (const name of ["code", "error"]) {
    const value = target.searchParams.get(name);
    if (value !== null && value !== "") return true;
  }

  return false;
}

export function startCallbackServer(
  options: CallbackServerOptions = {},
): Promise<CallbackServer> {
  const path = options.path ?? DEFAULT_CALLBACK_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const port = options.port ?? EPHEMERAL_PORT;

  try {
    assertCallbackPath(path);
    assertTimeout(timeoutMs);
  } catch (error) {
    // Rejected rather than thrown: a caller that awaits this function should
    // not also have to wrap it, or the mistake it is protected from is the one
    // where a bad path takes down the process instead of failing the sign-in.
    return Promise.reject(error);
  }

  let resolveReceived: (url: string) => void = () => {};
  let rejectReceived: (reason: unknown) => void = () => {};
  const received = new Promise<string>((resolve, reject) => {
    resolveReceived = resolve;
    rejectReceived = reject;
  });

  /**
   * The wait has a rejection handler from birth.
   *
   * A caller that stops awaiting — it raced this against something else, or the
   * sign-in was abandoned — must not take the process down with an unhandled
   * rejection when the deadline eventually passes. Attaching a handler here
   * takes nothing away from the caller: `received` still rejects for anyone who
   * does await it.
   */
  received.catch(() => {});

  const server = createServer();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Set once the kernel has answered, and the reason a request can be read at
   * all: with an ephemeral port the origin the browser used is not known until
   * the socket is bound, and a url resolved against the port we *asked* for is
   * a url naming port 0.
   */
  let origin: string | undefined;

  function stopWaiting(reason: CallbackServerError): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    // Destroy first, then stop listening: `close` alone waits for open
    // connections, so a browser that opened a socket and said nothing would
    // keep the port — and the process — alive after the caller gave up.
    server.closeAllConnections();
    server.close();
    rejectReceived(reason);
  }

  server.on("request", (request, response) => {
    /**
     * Parsed defensively, because the request target is attacker-controlled.
     *
     * `new URL` throws on a target the WHATWG parser cannot make sense of —
     * `//[/` is enough — and Node does not wrap the `request` emit, so an
     * uncaught `TypeError` here took the whole host process down. The port is
     * guessable and any page in another tab can make a browser send that
     * request, so this was a remote kill switch on a process waiting to sign in.
     */
    const target = parseTarget(request.url, origin);

    /**
     * Anything that is not the browser following the redirect is not the thing
     * this listener is waiting for, and answering it would spend the single use
     * the real redirect needs.
     *
     * The origin is checked as well as the path. A protocol-relative or
     * absolute-form target — `//evil.example/callback`, or a raw
     * `GET http://evil.example/callback HTTP/1.1` — parses to a *different*
     * origin while keeping the expected pathname, and would otherwise spend the
     * single use and hand the caller a url naming a host nobody here chose.
     *
     * The path is compared whole. A prefix match would let
     * `/callback-not-really?code=…` pass for the redirect, which is a path an
     * authorization server was never given and never sends.
     *
     * And the query has to look like an authorization response, which is the
     * part that keeps the promise the other checks cannot make: see
     * `looksLikeAuthorizationResponse`.
     */
    if (
      settled ||
      target === undefined ||
      request.method !== "GET" ||
      target.origin !== origin ||
      target.pathname !== path ||
      !looksLikeAuthorizationResponse(target)
    ) {
      respond(response, 404, NOT_FOUND_PAGE);
      return;
    }

    settled = true;
    clearTimeout(timer);
    // Stop listening before the answer is even written. From here the flow has
    // its code, and a second request on this port can only be a forgery or a
    // reload — neither of which anything downstream is expecting to arbitrate.
    // `close` sweeps the connections sitting idle on its way out, so there is
    // no separate call for those.
    server.close();

    respond(response, 200, DONE_PAGE, () => {
      // Swept only now, because sweeping every connection a moment earlier
      // destroys the very socket this response is owed to. `close` above took
      // the idle sockets; this catches the other kind — a browser that sent a
      // partial request and stopped, which is not idle and which nothing reaps
      // now that `close` has cleared node's connection-checking interval. It
      // would otherwise hold the event loop open after a *successful* sign-in,
      // the one path where nothing later cleans up, and a CLI holding its
      // authorization code would hang at exit instead of finishing.
      server.closeAllConnections();
      // Resolved once the page is on the wire, so a caller that has the url
      // also has a released port and a browser that has been told to stop.
      resolveReceived(target.toString());
    });
  });

  return new Promise<CallbackServer>((ready, failed) => {
    server.on("error", (error) => {
      const failure = new CallbackServerError(
        `Could not receive the authorization callback on ${LOOPBACK_HOST}:${port} — ${error.message}.`,
      );

      // Nothing the browser sent is in scope here: this is the socket failing,
      // not a request being read.
      if (origin !== undefined) {
        stopWaiting(failure);
        return;
      }

      // Not closed on this path — the listen never took, and closing a server
      // that was never listening raises another error on this same handler.
      settled = true;
      failed(failure);
    });

    server.on("listening", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        // A pipe or unix socket, which `listen(port, host)` cannot produce. The
        // types allow it, and guessing a port here would be worse than saying
        // so.
        server.close();
        settled = true;
        failed(
          new CallbackServerError(
            "The callback listener did not bind a tcp port, so there is no redirect uri to hand the authorization server.",
          ),
        );
        return;
      }

      origin = `http://${address.address}:${address.port}`;
      timer = setTimeout(() => {
        stopWaiting(
          new CallbackServerError(
            `No authorization callback arrived within ${timeoutMs}ms. Closing the listener rather than holding a port open for a browser that is not coming.`,
          ),
        );
      }, timeoutMs);

      ready({
        close(): void {
          stopWaiting(
            new CallbackServerError(
              "The wait for the authorization callback was cancelled, and the listener is closed.",
            ),
          );
        },
        // Reported from what the kernel says it bound, not from what was asked
        // for, so a caller building a redirect uri is quoting the truth.
        host: address.address,
        path,
        port: address.port,
        received,
        redirectUri: `${origin}${path}`,
      });
    });

    server.listen(port, LOOPBACK_HOST);
  });
}
