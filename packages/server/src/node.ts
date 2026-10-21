/**
 * The Node adapter (Plan 13, H.1; manifest-h.md §2.2; rulings 87 and 143;
 * H.0b's names): a `node:http` server that hands each request to a fetch
 * handler, `(Request) => Promise<Response>`.
 *
 * Before any handler sees a request, in this order:
 *
 * 1. **The `Host` rule.** The public URL's origin is the only one served. A
 *    request naming another host (its `Host`, or, from the trusted proxy
 *    only, the last entry of `x-forwarded-host`) is answered `308` to the
 *    same path and query on the public URL for `GET` and `HEAD`, and `421`
 *    for any other method. A DNS-rebinding page, whose requests name its
 *    own domain, reaches no handler.
 * 2. **A trailing slash.** A path that resolves (below) to one ending in
 *    `/`, other than `/` itself, is answered `308` to that path without it,
 *    the query kept, as Next does with its default `trailingSlash: false`.
 *    So the route table never sees one: every prefix entry would otherwise
 *    catch the trailing-slash form of a more specific exact entry (ruling
 *    143).
 * 3. **The forwarding rewrite.** `x-vercel-forwarded-for`, which no self-host
 *    sits behind, is removed, and `x-forwarded-for` is set to the socket's
 *    remote address. From the trusted proxy only, it is the last entry of
 *    the `x-forwarded-for` that proxy sent: the address the proxy itself saw.
 *    So `requestIp` reads a value the client cannot choose.
 *
 * **The path every decision after the `Host` rule is made on** is the one
 * the request target resolves to: the target parsed as a URL after the
 * public URL's origin (WHATWG URL parsing), which removes dot segments,
 * percent-encoded ones included, so that `/x/../api/health/live` and
 * `/%2e%2e/api/health/live` are both `/api/health/live`. It is the path the
 * handler's `Request` carries, and the path Next routes on (`next@16.3.1`,
 * `dist/shared/lib/router/utils/parse-relative-url.js:18`, which parses
 * `http://n` followed by the target, **read**). Decided on the target as
 * written, a dot-segment path to one of the host's routes would be handed to
 * the fallback, and Next would answer it from its own copy of that route
 * (measured against the self-host build after H.5's independent review).
 * Other percent-encoded characters stay encoded on both sides, and Next does
 * not decode them to choose a route (measured: `/api/health/%6Cive` and
 * `/%61pi/health/live` are answered by Next's `404`).
 *
 * **The Node-level fallback (H.5; manifest-h.md §2.7.1; ruling 160, item 3).**
 * Next's request handler takes Node's request and response, not a `Request`.
 * So a path `options.fallback` says it serves (asked with the path the
 * request resolves to, above, without the query) is handed to it as Node's
 * request and response, after the three steps above and before any
 * `Request` is built: its `url` is that resolved path and its query, never
 * the target's authority, and the forwarding rewrite is applied to its
 * `headers`, the object Next reads `x-forwarded-for` from (`next@16.3.1`,
 * `dist/server/base-server.js:612`, **read**), as H.0b's K6 host did. Its
 * `rawHeaders` are left as they came.
 * The body is left on the socket for the fallback to read. A fallback that
 * throws before it has written anything is answered `500`; one that fails
 * once it has, by closing the connection. Every other path goes to the
 * handler, as without a fallback. `TRACE`, below, is answered `501` on every
 * path.
 *
 * Every `Location` these answers carry is built from the public URL's
 * origin and the request's path and query, never from what the request
 * names as its authority. The handler's `Request` has the same URL; its body
 * streams from the socket as the handler reads it (none for `GET` and
 * `HEAD`), and its signal aborts when the connection closes before the
 * response is finished. What the handler leaves of the body unread, by
 * answering without reading it or by cancelling it part-way (a body past
 * its bound), is read off the socket and discarded once the response is
 * finished, as Node discards a body no listener read, so the next request
 * on a kept-alive connection is served. The response
 * streams back as the handler writes it, every `set-cookie` kept, with no
 * body for `HEAD`. `TRACE`, which the fetch standard forbids and no
 * `Request` can carry, is answered `501`; a handler that throws, or answers
 * something other than a `Response`, `500`. The public URL must be an
 * origin.
 *
 * The adapter is not on Vercel's path: there, Next serves the routes.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

export type RequestPortHandler = (request: Request) => Promise<Response>;

/**
 * What serves the paths the handler does not, over Node's request and
 * response: under `requestport start`, Next's request handler (above).
 */
export interface NodeFallback {
  /** Whether `pathname`, the request's path as it names it, is this fallback's. */
  serves(pathname: string): boolean;
  /** Answers the request; settles once it has, or rejects. */
  handle(incoming: IncomingMessage, outgoing: ServerResponse): Promise<unknown>;
}

export interface ListenOptions {
  /** The address to listen on. */
  host: string;
  /** The port to listen on; `0` lets the system choose one. */
  port: number;
  /** The one origin this host serves: the issuer, `BETTER_AUTH_URL`. */
  publicUrl: string;
  /** The address of the one reverse proxy whose forwarding headers are read. */
  trustedProxy?: string;
  /** The paths it serves are handed to it, not to the handler (above). */
  fallback?: NodeFallback;
}

export interface RunningHost {
  /** Where the server listens: `http://<address>:<port>`. */
  url: string;
  /** Stops listening and closes every connection, open streams included. */
  close(): Promise<void>;
}

const ipv4Mapped = /^::ffff:(?=\d{1,3}(?:\.\d{1,3}){3}$)/iu;

/**
 * Whether two addresses are the same, an IPv4 address and its IPv4-mapped
 * IPv6 form (`::ffff:127.0.0.1`) included, whatever their case.
 */
export function sameAddress(a: string, b: string): boolean {
  const plain = (address: string) =>
    address.trim().toLowerCase().replace(ipv4Mapped, "");
  return plain(a) === plain(b);
}

/** The last entry of a comma-separated header, across repeated lines. */
function lastEntry(value: string | string[] | undefined): string | undefined {
  const joined = Array.isArray(value) ? value.join(",") : value;
  return joined
    ?.split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .at(-1);
}

/** The path and query a request target names: never its authority. */
function pathAndQuery(target: string | undefined): string {
  if (target?.startsWith("/")) return target;
  try {
    const url = new URL(target ?? "");
    return `${url.pathname}${url.search}`;
  } catch {
    return "/";
  }
}

/** The `host[:port]` a header names, read with the public URL's scheme; null when it names none. */
function hostNamed(value: string | undefined, protocol: string) {
  if (!value) return null;
  try {
    const url = new URL(`${protocol}//${value}`);
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.host;
  } catch {
    return null;
  }
}

function refuse(response: ServerResponse, status: number, location?: string) {
  response.statusCode = status;
  if (location) response.setHeader("location", location);
  response.setHeader("cache-control", "no-store");
  response.end();
}

/**
 * The request's body as the stream a `Request` carries, read from the socket
 * as the handler pulls it, and `discard`, which reads the rest off the
 * socket and drops it, the stream left as it is.
 */
function requestBody(incoming: IncomingMessage) {
  let settled = false;
  let discarding = false;
  let onData: (chunk: Buffer) => void = () => {};
  const discard = () => {
    if (discarding) return;
    discarding = true;
    incoming.off("data", onData);
    incoming.resume();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const settle = (finish: () => void) => {
        if (settled || discarding) return;
        settled = true;
        finish();
      };
      onData = (chunk) => {
        controller.enqueue(
          new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        );
        if ((controller.desiredSize ?? 0) <= 0) incoming.pause();
      };
      incoming.on("data", onData);
      incoming.once("end", () => settle(() => controller.close()));
      incoming.once("error", (error) => settle(() => controller.error(error)));
      incoming.once("close", () => {
        if (!incoming.complete)
          settle(() =>
            controller.error(new Error("The request body was cut short")),
          );
      });
    },
    pull() {
      incoming.resume();
    },
    cancel() {
      discard();
    },
  });
  return { stream, discard };
}

function requestHeaders(incoming: IncomingMessage) {
  const headers = new Headers();
  const raw = incoming.rawHeaders;
  for (let index = 0; index + 1 < raw.length; index += 2) {
    headers.append(raw[index] as string, raw[index + 1] as string);
  }
  return headers;
}

async function serve(
  handler: RequestPortHandler,
  options: ListenOptions,
  publicUrl: URL,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
) {
  const method = incoming.method ?? "GET";
  const socketAddress = incoming.socket.remoteAddress ?? "";
  const fromProxy =
    options.trustedProxy !== undefined &&
    sameAddress(socketAddress, options.trustedProxy);
  const target = pathAndQuery(incoming.url);

  const named = fromProxy
    ? (lastEntry(incoming.headers["x-forwarded-host"]) ?? incoming.headers.host)
    : incoming.headers.host;
  if (hostNamed(named, publicUrl.protocol) !== publicUrl.host) {
    if (method === "GET" || method === "HEAD") {
      refuse(outgoing, 308, `${publicUrl.origin}${target}`);
    } else {
      refuse(outgoing, 421);
    }
    return;
  }

  // The path the target resolves to (above): every decision below is made
  // on it, the handler's Request carries it, and the fallback is handed it.
  const resolved = new URL(`${publicUrl.origin}${target}`);
  const { pathname, search } = resolved;
  if (pathname.length > 1 && pathname.endsWith("/")) {
    const trimmed = pathname.replace(/\/+$/u, "") || "/";
    refuse(outgoing, 308, `${publicUrl.origin}${trimmed}${search}`);
    return;
  }

  // The fetch standard forbids these methods and `new Request` throws on
  // them, so no handler can be handed one: 501. Of the three, only TRACE
  // reaches this function on Node 22: its parser refuses TRACK with a 400
  // (`http.METHODS` lacks it), and it emits CONNECT as the server's
  // `connect` event, closing the connection when nothing listens.
  if (/^(?:connect|trace|track)$/iu.test(method)) {
    refuse(outgoing, 501);
    return;
  }

  const forwardedFor =
    (fromProxy ? lastEntry(incoming.headers["x-forwarded-for"]) : undefined) ??
    socketAddress;

  if (options.fallback?.serves(pathname)) {
    delete incoming.headers["x-vercel-forwarded-for"];
    incoming.headers["x-forwarded-for"] = forwardedFor;
    incoming.url = `${pathname}${search}`;
    try {
      await options.fallback.handle(incoming, outgoing);
    } catch {
      if (!outgoing.headersSent) refuse(outgoing, 500);
      else outgoing.destroy();
    }
    return;
  }

  const headers = requestHeaders(incoming);
  headers.delete("x-vercel-forwarded-for");
  headers.set("x-forwarded-for", forwardedFor);

  const aborted = new AbortController();
  outgoing.on("close", () => {
    if (!outgoing.writableFinished) aborted.abort();
  });
  const body =
    method !== "GET" && method !== "HEAD" ? requestBody(incoming) : undefined;
  if (body)
    outgoing.once("finish", () => {
      if (!incoming.readableEnded) body.discard();
    });
  const request = new Request(resolved, {
    method,
    headers,
    signal: aborted.signal,
    ...(body ? { body: body.stream, duplex: "half" } : {}),
  } as RequestInit);

  let response: Response;
  try {
    response = await handler(request);
  } catch {
    if (!outgoing.headersSent) refuse(outgoing, 500);
    else outgoing.destroy();
    return;
  }

  outgoing.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") outgoing.setHeader(name, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) outgoing.setHeader("set-cookie", cookies);
  if (method === "HEAD" || !response.body) {
    await response.body?.cancel();
    outgoing.end();
    return;
  }
  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeReadableStream),
      outgoing,
    );
  } catch {
    // The client went away, or the handler's stream failed: nothing is left
    // to answer, and the connection is closed.
    outgoing.destroy();
  }
}

/**
 * Serves `handler` on `options.host` and `options.port`, as the public URL
 * `options.publicUrl`, until `close()`.
 */
export async function listen(
  handler: RequestPortHandler,
  options: ListenOptions,
): Promise<RunningHost> {
  const publicUrl = new URL(options.publicUrl);
  if (publicUrl.protocol !== "http:" && publicUrl.protocol !== "https:") {
    throw new TypeError("The public URL must be http: or https:");
  }
  if (
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.pathname !== "/" ||
    publicUrl.search ||
    publicUrl.hash
  ) {
    throw new TypeError(
      "The public URL must be an origin: no credentials, path, query or fragment",
    );
  }
  const server = createServer((incoming, outgoing) => {
    serve(handler, options, publicUrl, incoming, outgoing).catch(() => {
      // Anything the conversion did not expect, a handler's answer that is
      // not a Response among them: a 500 if nothing was written yet, and the
      // connection closed otherwise. The server keeps serving.
      if (!outgoing.headersSent) refuse(outgoing, 500);
      else outgoing.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const host =
    address.family === "IPv6" ? `[${address.address}]` : address.address;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${host}:${address.port}`,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
