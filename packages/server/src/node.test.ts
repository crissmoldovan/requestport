import {
  Agent,
  request as httpRequest,
  type IncomingHttpHeaders,
} from "node:http";

import { afterEach, describe, expect, test } from "vitest";

import {
  listen,
  type NodeFallback,
  type RunningHost,
  sameAddress,
} from "./node.js";

/*
  The Node adapter (manifest-h.md §2.2; rulings 87 and 143; H.0b's names):
  the `Host` rule, then a trailing slash, then the forwarding rewrite, then
  the handler, which sees a `Request` built from the public URL. Every case
  listens on 127.0.0.1, on a port the system picks, and sends with
  `node:http`, which lets a case choose the `Host` header and the raw request
  target.
*/

type Seen = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
};

const publicUrl = "http://requestport.test";
const running: RunningHost[] = [];
let seen: Seen[] = [];
let answer: (request: Request) => Response | Promise<Response> = () =>
  new Response("handled", { status: 200 });

afterEach(async () => {
  await Promise.all(running.splice(0).map((host) => host.close()));
  seen = [];
  answer = () => new Response("handled", { status: 200 });
});

async function start(
  options: {
    publicUrl?: string;
    trustedProxy?: string;
    fallback?: NodeFallback;
  } = {},
) {
  const host = await listen(
    async (request) => {
      seen.push({
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers),
        body: request.body ? await request.clone().text() : "",
        signal: request.signal,
      });
      return answer(request);
    },
    {
      host: "127.0.0.1",
      port: 0,
      publicUrl: options.publicUrl ?? publicUrl,
      ...(options.trustedProxy ? { trustedProxy: options.trustedProxy } : {}),
      ...(options.fallback ? { fallback: options.fallback } : {}),
    },
  );
  running.push(host);
  return host;
}

type Sent = {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
};

function send(
  host: RunningHost,
  init: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
    setHost?: boolean;
  } = {},
): Promise<Sent> {
  const { port } = new URL(host.url);
  const length =
    init.body === undefined
      ? {}
      : { "content-length": String(Buffer.byteLength(init.body)) };
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port: Number(port),
        method: init.method ?? "GET",
        path: init.path ?? "/api/v1/whoami",
        headers:
          init.setHost === false
            ? { ...length, ...init.headers }
            : { host: "requestport.test", ...length, ...init.headers },
        setHost: init.setHost ?? true,
        // A fresh connection each time, so a closed host is seen as closed.
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.on("error", reject);
      },
    );
    outgoing.on("error", reject);
    outgoing.end(init.body);
  });
}

describe("the client address", () => {
  test("x-forwarded-for is the socket's address, whatever the client sends, and x-vercel-forwarded-for is removed", async () => {
    const host = await start();
    await send(host, {
      headers: {
        "x-forwarded-for": "6.6.6.6",
        "x-vercel-forwarded-for": "7.7.7.7",
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers["x-forwarded-for"]).toBe("127.0.0.1");
    expect(seen[0]?.headers).not.toHaveProperty("x-vercel-forwarded-for");
  });

  test("a request with no forwarding header gets the socket's address", async () => {
    const host = await start();
    await send(host);
    expect(seen[0]?.headers["x-forwarded-for"]).toBe("127.0.0.1");
  });

  test("from the trusted proxy, the last entry of its x-forwarded-for: the address the proxy saw", async () => {
    const host = await start({ trustedProxy: "127.0.0.1" });
    await send(host, {
      headers: {
        "x-forwarded-for": "6.6.6.6, 203.0.113.9",
        "x-vercel-forwarded-for": "7.7.7.7",
      },
    });
    expect(seen[0]?.headers["x-forwarded-for"]).toBe("203.0.113.9");
    expect(seen[0]?.headers).not.toHaveProperty("x-vercel-forwarded-for");
  });

  test("the trusted proxy sending no x-forwarded-for: its own address", async () => {
    const host = await start({ trustedProxy: "127.0.0.1" });
    await send(host);
    expect(seen[0]?.headers["x-forwarded-for"]).toBe("127.0.0.1");
  });

  test("the trusted proxy named in its IPv4-mapped IPv6 form is the same proxy", async () => {
    const host = await start({ trustedProxy: "::ffff:127.0.0.1" });
    await send(host, {
      headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" },
    });
    expect(seen[0]?.headers["x-forwarded-for"]).toBe("203.0.113.9");
  });

  test("a socket that is not the trusted proxy: its x-forwarded-for is not believed", async () => {
    const host = await start({ trustedProxy: "192.0.2.1" });
    await send(host, { headers: { "x-forwarded-for": "203.0.113.9" } });
    expect(seen[0]?.headers["x-forwarded-for"]).toBe("127.0.0.1");
  });

  test.each([
    ["127.0.0.1", "::ffff:127.0.0.1", true],
    ["::ffff:127.0.0.1", "127.0.0.1", true],
    ["::FFFF:127.0.0.1", "127.0.0.1", true],
    ["::1", "::1", true],
    ["127.0.0.1", "127.0.0.2", false],
    ["::ffff:127.0.0.1", "::1", false],
  ])("%s and %s are the same address: %s", (a, b, same) => {
    expect(sameAddress(a, b)).toBe(same);
  });
});

describe("the Host rule", () => {
  test.each(["GET", "HEAD"])(
    "%s with a Host other than the public URL's: 308 to the same path and query on the public URL, and no handler",
    async (method) => {
      const host = await start();
      const sent = await send(host, {
        method,
        path: "/api/v1/whoami?x=1",
        headers: { host: "evil.test" },
      });
      expect(sent.status).toBe(308);
      expect(sent.headers.location).toBe(
        "http://requestport.test/api/v1/whoami?x=1",
      );
      expect(seen).toEqual([]);
    },
  );

  test.each(["POST", "DELETE", "PUT"])(
    "%s with a Host other than the public URL's: 421, and no handler",
    async (method) => {
      const host = await start();
      const sent = await send(host, {
        method,
        path: "/mcp",
        headers: { host: "evil.test", "content-type": "application/json" },
        body: "{}",
      });
      expect(sent.status).toBe(421);
      expect(sent.headers.location).toBeUndefined();
      expect(seen).toEqual([]);
    },
  );

  test("an HTTP/1.1 request without a Host header: refused by Node itself, and no handler", async () => {
    // `requireHostHeader`, which Node's server enables by default, answers
    // 400 before the adapter sees the request.
    const host = await start();
    const sent = await send(host, { method: "POST", setHost: false });
    expect(sent.status).toBe(400);
    expect(seen).toEqual([]);
  });

  test("the public URL's host matches whatever its case, and with its scheme's default port", async () => {
    const host = await start();
    await send(host, { headers: { host: "RequestPort.Test" } });
    await send(host, { headers: { host: "requestport.test:80" } });
    expect(seen).toHaveLength(2);
  });

  test("a public URL with a port: the Host must name that port", async () => {
    const host = await start({ publicUrl: "http://localhost:4123" });
    const sent = await send(host, {
      path: "/sign-in",
      headers: { host: "localhost" },
    });
    expect(sent.status).toBe(308);
    expect(sent.headers.location).toBe("http://localhost:4123/sign-in");
    await send(host, { path: "/sign-in", headers: { host: "localhost:4123" } });
    expect(seen.map((request) => request.url)).toEqual([
      "http://localhost:4123/sign-in",
    ]);
  });

  test("every Location is built from the public URL, whatever the request target names", async () => {
    const host = await start();
    const absolute = await send(host, {
      path: "http://evil.test/x?y=1",
      headers: { host: "evil.test" },
    });
    expect(absolute.headers.location).toBe("http://requestport.test/x?y=1");
    const schemeRelative = await send(host, {
      path: "//evil.test/x",
      headers: { host: "evil.test" },
    });
    expect(schemeRelative.headers.location).toBe(
      "http://requestport.test//evil.test/x",
    );
    expect(seen).toEqual([]);
  });

  test("the handler's URL is the public URL's, whatever the request target names", async () => {
    const host = await start();
    await send(host, { path: "http://evil.test/api/v1/whoami?y=1" });
    await send(host, { path: "//evil.test/x" });
    expect(seen.map((request) => request.url)).toEqual([
      "http://requestport.test/api/v1/whoami?y=1",
      "http://requestport.test//evil.test/x",
    ]);
  });

  test("from the trusted proxy, x-forwarded-host is the host the client named", async () => {
    const host = await start({ trustedProxy: "127.0.0.1" });
    await send(host, {
      headers: {
        host: "internal.test:8080",
        "x-forwarded-host": "evil.test, requestport.test",
      },
    });
    expect(seen).toHaveLength(1);
    const refused = await send(host, {
      headers: { host: "requestport.test", "x-forwarded-host": "evil.test" },
    });
    expect(refused.status).toBe(308);
    expect(seen).toHaveLength(1);
  });

  test("from any other socket, x-forwarded-host is not read", async () => {
    const host = await start({ trustedProxy: "192.0.2.1" });
    const refused = await send(host, {
      headers: {
        host: "internal.test",
        "x-forwarded-host": "requestport.test",
      },
    });
    expect(refused.status).toBe(308);
    await send(host, {
      headers: { host: "requestport.test", "x-forwarded-host": "evil.test" },
    });
    expect(seen).toHaveLength(1);
  });
});

describe("a trailing slash", () => {
  test("GET: 308 to the path without it, the query kept, and no handler", async () => {
    const host = await start();
    const sent = await send(host, {
      path: "/api/v1/imports/artifacts/?a=1&b=2",
    });
    expect(sent.status).toBe(308);
    expect(sent.headers.location).toBe(
      "http://requestport.test/api/v1/imports/artifacts?a=1&b=2",
    );
    expect(seen).toEqual([]);
  });

  test("POST: 308 as well, which keeps the method", async () => {
    const host = await start();
    const sent = await send(host, {
      method: "POST",
      path: "/mcp/",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(sent.status).toBe(308);
    expect(sent.headers.location).toBe("http://requestport.test/mcp");
    expect(seen).toEqual([]);
  });

  test("every trailing slash goes, in one redirect", async () => {
    const host = await start();
    const sent = await send(host, { path: "/api/auth//" });
    expect(sent.headers.location).toBe("http://requestport.test/api/auth");
  });

  test("/ itself is not redirected", async () => {
    const host = await start();
    const sent = await send(host, { path: "/" });
    expect(sent.status).toBe(200);
    expect(seen.map((request) => request.url)).toEqual([
      "http://requestport.test/",
    ]);
  });

  test("the Host rule answers first", async () => {
    const host = await start();
    const sent = await send(host, {
      path: "/mcp/",
      headers: { host: "evil.test" },
    });
    expect(sent.headers.location).toBe("http://requestport.test/mcp/");
  });
});

describe("the conversion", () => {
  test("the handler sees the public URL, the method, the headers and the body", async () => {
    const host = await start();
    await send(host, {
      method: "POST",
      path: "/api/v1/commands/x?q=1",
      headers: { "content-type": "text/plain", "x-custom": "kept" },
      body: "hello, host",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: "POST",
      url: "http://requestport.test/api/v1/commands/x?q=1",
      body: "hello, host",
      headers: { "content-type": "text/plain", "x-custom": "kept" },
    });
  });

  test("a GET carries no body", async () => {
    const host = await start();
    await send(host);
    expect(seen[0]?.body).toBe("");
  });

  test("the response's status, headers, every set-cookie and body reach the client", async () => {
    answer = () => {
      const headers = new Headers({ "x-answer": "yes" });
      headers.append("set-cookie", "a=1; Path=/");
      headers.append("set-cookie", "b=2; Path=/");
      return new Response("created", { status: 201, headers });
    };
    const host = await start();
    const sent = await send(host);
    expect(sent.status).toBe(201);
    expect(sent.headers["x-answer"]).toBe("yes");
    expect(sent.headers["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(sent.body).toBe("created");
  });

  test("HEAD answers no body", async () => {
    answer = () => new Response("not for HEAD", { status: 200 });
    const host = await start();
    const sent = await send(host, { method: "HEAD" });
    expect(sent.status).toBe(200);
    expect(sent.body).toBe("");
  });

  test("a streamed response reaches the client as it is written", async () => {
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    answer = () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("data: one\n\n"));
            await released;
            controller.enqueue(new TextEncoder().encode("data: two\n\n"));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    const host = await start();
    const { port } = new URL(host.url);
    const chunks: string[] = await new Promise((resolve, reject) => {
      const received: string[] = [];
      httpRequest(
        {
          host: "127.0.0.1",
          port: Number(port),
          path: "/mcp",
          headers: { host: "requestport.test" },
        },
        (response) => {
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            received.push(chunk);
            // The second event is written only after the first has arrived.
            if (received.length === 1) release();
          });
          response.on("end", () => resolve(received));
          response.on("error", reject);
        },
      )
        .on("error", reject)
        .end();
    });
    expect(chunks.join("")).toBe("data: one\n\ndata: two\n\n");
    expect(chunks[0]).toBe("data: one\n\n");
  });

  test("the request's signal aborts when the client goes away", async () => {
    answer = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: open\n\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    const host = await start();
    const { port } = new URL(host.url);
    await new Promise<void>((resolve, reject) => {
      const outgoing = httpRequest(
        {
          host: "127.0.0.1",
          port: Number(port),
          path: "/mcp",
          headers: { host: "requestport.test" },
        },
        (response) => {
          response.once("data", () => {
            outgoing.destroy();
            resolve();
          });
        },
      );
      outgoing.on("error", () => {});
      outgoing.on("timeout", reject);
      outgoing.end();
    });
    const signal = seen[0]?.signal;
    expect(signal).toBeDefined();
    await new Promise<void>((resolve) => {
      if (signal?.aborted) resolve();
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    expect(signal?.aborted).toBe(true);
  });

  test("a handler that throws answers 500", async () => {
    answer = () => {
      throw new Error("handler failed");
    };
    const host = await start();
    const sent = await send(host);
    expect(sent.status).toBe(500);
  });

  test("a handler that answers something other than a Response: 500, and the next request is served", async () => {
    answer = () => undefined as unknown as Response;
    const host = await start();
    expect((await send(host)).status).toBe(500);
    answer = () => new Response("handled", { status: 200 });
    expect((await send(host)).status).toBe(200);
  });

  test("a method the fetch Request cannot carry (TRACE): 501, no handler, and the next request is served", async () => {
    const host = await start();
    const sent = await send(host, { method: "TRACE" });
    expect(sent.status).toBe(501);
    expect(seen).toEqual([]);
    expect((await send(host)).status).toBe(200);
  });
});

describe("a body the handler leaves unread", () => {
  /**
   * Two POSTs of `size` bytes, each declaring its length, over one kept-alive
   * connection (an agent with one socket), to a host whose handler reads
   * each body as `read` says; each answer's status and body, and the local
   * port it came back on.
   */
  async function twoOnOneConnection(
    size: number,
    read: (request: Request) => Promise<Response>,
  ) {
    const host = await listen(read, {
      host: "127.0.0.1",
      port: 0,
      publicUrl,
    });
    running.push(host);
    const { port } = new URL(host.url);
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const post = () =>
      new Promise<{ status: number; body: string; localPort: number }>(
        (resolve, reject) => {
          const outgoing = httpRequest(
            {
              host: "127.0.0.1",
              port: Number(port),
              method: "POST",
              path: "/api/auth/sign-in/email",
              headers: {
                host: "requestport.test",
                "content-length": String(size),
              },
              agent,
            },
            (response) => {
              // Read as the answer arrives: once it has ended, the agent may
              // already have taken the socket back.
              const localPort = response.socket?.localPort ?? 0;
              const chunks: Buffer[] = [];
              response.on("data", (chunk: Buffer) => chunks.push(chunk));
              response.on("end", () =>
                resolve({
                  status: response.statusCode ?? 0,
                  body: Buffer.concat(chunks).toString("utf8"),
                  localPort,
                }),
              );
              response.on("error", reject);
            },
          );
          outgoing.on("error", reject);
          outgoing.end("a".repeat(size));
        },
      );
    try {
      return [await post(), await post()];
    } finally {
      agent.destroy();
    }
  }

  test("a handler that answers without reading it: the answer reaches the client, and the next request on the same connection is served", async () => {
    let handled = 0;
    const [first, second] = await twoOnOneConnection(256 * 1_024, async () => {
      handled += 1;
      return new Response(`answered ${handled}`, { status: 413 });
    });

    expect(first).toMatchObject({ status: 413, body: "answered 1" });
    expect(second).toMatchObject({ status: 413, body: "answered 2" });
    expect(first?.localPort).toBeGreaterThan(0);
    expect(second?.localPort).toBe(first?.localPort);
  });

  test("a handler that cancels it part-way: the answer reaches the client, and the next request on the same connection is served", async () => {
    let handled = 0;
    const [first, second] = await twoOnOneConnection(
      256 * 1_024,
      async (request) => {
        handled += 1;
        const reader = request.body?.getReader();
        await reader?.read();
        await reader?.cancel("too large");
        return new Response(`cancelled ${handled}`, { status: 413 });
      },
    );

    expect(first).toMatchObject({ status: 413, body: "cancelled 1" });
    expect(second).toMatchObject({ status: 413, body: "cancelled 2" });
    expect(first?.localPort).toBeGreaterThan(0);
    expect(second?.localPort).toBe(first?.localPort);
  });

  test("a handler that reads it all still sees every byte", async () => {
    const seenLengths: number[] = [];
    const [first, second] = await twoOnOneConnection(
      256 * 1_024,
      async (request) => {
        seenLengths.push((await request.arrayBuffer()).byteLength);
        return new Response("read");
      },
    );

    expect([first?.status, second?.status]).toEqual([200, 200]);
    expect(seenLengths).toEqual([256 * 1_024, 256 * 1_024]);
  });
});

describe("listen", () => {
  test("answers on the address it names, and stops on close", async () => {
    const host = await start();
    expect(host.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect((await send(host)).status).toBe(200);
    await host.close();
    running.splice(running.indexOf(host), 1);
    await expect(send(host)).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  test.each([
    "ftp://requestport.test",
    "http://requestport.test/base",
    "http://requestport.test/?q=1",
    "http://requestport.test/#f",
    "http://user:secret@requestport.test",
  ])(
    "refuses a public URL that is not an http or https origin: %s",
    async (url) => {
      await expect(
        listen(async () => new Response(null), {
          host: "127.0.0.1",
          port: 0,
          publicUrl: url,
        }),
      ).rejects.toThrow(TypeError);
    },
  );
});

/*
  The Node-level fallback (H.5's slice e; manifest-h.md §2.7.1; ruling 160,
  item 3): Next's request handler takes Node's request and response, so the
  adapter hands it every path the fallback says it serves, after the `Host`
  rule, the trailing slash and the forwarding rewrite, and before any
  `Request` is built.
*/
type FellBack = {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
};

describe("the Node-level fallback", () => {
  let fellBack: FellBack[] = [];
  let asked: string[] = [];

  afterEach(() => {
    fellBack = [];
    asked = [];
  });

  /**
   * A fallback that serves every path under `prefix` (or every path
   * `prefix` answers true for), records what it was asked and handed, and
   * answers `respond`'s answer or 200 "next".
   */
  function fallbackFor(
    prefix: string | ((pathname: string) => boolean),
    respond?: NodeFallback["handle"],
  ): NodeFallback {
    return {
      serves(pathname) {
        asked.push(pathname);
        return typeof prefix === "string"
          ? pathname.startsWith(prefix)
          : prefix(pathname);
      },
      async handle(incoming, outgoing) {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(chunk as Buffer);
        fellBack.push({
          method: incoming.method,
          url: incoming.url,
          headers: { ...incoming.headers },
          body: Buffer.concat(chunks).toString("utf8"),
        });
        if (respond) return respond(incoming, outgoing);
        outgoing.statusCode = 200;
        outgoing.setHeader("x-answered-by", "fallback");
        outgoing.end("next");
      },
    };
  }

  test("a path it serves reaches it as Node's request and response, its path and query intact, and the fetch handler is not called", async () => {
    const host = await start({ fallback: fallbackFor("/sign-in") });
    const sent = await send(host, { path: "/sign-in?next=%2Fprojects" });
    expect(sent).toMatchObject({ status: 200, body: "next" });
    expect(sent.headers["x-answered-by"]).toBe("fallback");
    expect(asked).toEqual(["/sign-in"]);
    expect(fellBack).toMatchObject([
      { method: "GET", url: "/sign-in?next=%2Fprojects" },
    ]);
    expect(seen).toEqual([]);
  });

  test("a path it does not serve reaches the fetch handler, as without a fallback", async () => {
    const host = await start({ fallback: fallbackFor("/sign-in") });
    const sent = await send(host, { path: "/api/v1/whoami?x=1" });
    expect(sent).toMatchObject({ status: 200, body: "handled" });
    expect(asked).toEqual(["/api/v1/whoami"]);
    expect(fellBack).toEqual([]);
    expect(seen.map((request) => request.url)).toEqual([
      "http://requestport.test/api/v1/whoami?x=1",
    ]);
  });

  test("the Host rule answers first: 308 for GET, 421 for POST, and the fallback is neither asked nor called", async () => {
    const host = await start({ fallback: fallbackFor("/") });
    const get = await send(host, {
      path: "/sign-in?x=1",
      headers: { host: "evil.test" },
    });
    expect(get.status).toBe(308);
    expect(get.headers.location).toBe("http://requestport.test/sign-in?x=1");
    const post = await send(host, {
      method: "POST",
      path: "/sign-in",
      headers: { host: "evil.test" },
      body: "a=1",
    });
    expect(post.status).toBe(421);
    expect(asked).toEqual([]);
    expect(fellBack).toEqual([]);
  });

  test("a trailing slash is redirected first, and the fallback is neither asked nor called", async () => {
    const host = await start({ fallback: fallbackFor("/") });
    const sent = await send(host, { path: "/settings/projects/?tab=1" });
    expect(sent.status).toBe(308);
    expect(sent.headers.location).toBe(
      "http://requestport.test/settings/projects?tab=1",
    );
    expect(asked).toEqual([]);
    expect(fellBack).toEqual([]);
  });

  test("the forwarding rewrite applies to the Node request's headers: x-vercel-forwarded-for removed, x-forwarded-for the socket's address", async () => {
    const host = await start({ fallback: fallbackFor("/") });
    await send(host, {
      path: "/sign-in",
      headers: {
        "x-forwarded-for": "6.6.6.6",
        "x-vercel-forwarded-for": "7.7.7.7",
      },
    });
    expect(fellBack[0]?.headers["x-forwarded-for"]).toBe("127.0.0.1");
    expect(fellBack[0]?.headers).not.toHaveProperty("x-vercel-forwarded-for");
  });

  test("from the trusted proxy, the fallback sees the last entry of its x-forwarded-for", async () => {
    const host = await start({
      trustedProxy: "127.0.0.1",
      fallback: fallbackFor("/"),
    });
    await send(host, {
      path: "/sign-in",
      headers: {
        "x-forwarded-for": "6.6.6.6, 203.0.113.9",
        "x-vercel-forwarded-for": "7.7.7.7",
      },
    });
    expect(fellBack[0]?.headers["x-forwarded-for"]).toBe("203.0.113.9");
    expect(fellBack[0]?.headers).not.toHaveProperty("x-vercel-forwarded-for");
  });

  test("an absolute request target reaches it as its path and query, never its authority", async () => {
    const host = await start({ fallback: fallbackFor("/sign-in") });
    await send(host, { path: "http://requestport.test/sign-in?x=1" });
    expect(asked).toEqual(["/sign-in"]);
    expect(fellBack.map((request) => request.url)).toEqual(["/sign-in?x=1"]);
  });

  /*
    A request target with dot segments, plain or percent-encoded, is
    decided on the path it resolves to: the path the handler's `Request`
    carries, and the path Next routes on (`next@16.3.1`,
    `dist/shared/lib/router/utils/parse-relative-url.js:18`, which parses
    `http://n` followed by the target). Decided on the target as written,
    `/x/../api/health/live` would be the fallback's, and Next would answer
    it from its own copy of the host's liveness route (measured against the
    self-host build after H.5's independent review).
    The fallback below serves every path but the host's, as
    `requestport start`'s does; here the host's are those under `/api/`.
  */
  const everyPathButTheHosts = (pathname: string) =>
    !pathname.startsWith("/api/");

  test.each([
    ["/x/../api/health/live", "/api/health/live"],
    ["/%2e%2e/api/v1/projects", "/api/v1/projects"],
    ["/sign-in/../api/auth/get-session", "/api/auth/get-session"],
    ["/x/%2E%2e/api/v1/projects?x=1", "/api/v1/projects?x=1"],
  ])(
    "a dot-segment target, %s, that resolves to a path the fallback does not serve reaches the handler as %s, and never the fallback",
    async (target, resolved) => {
      const host = await start({ fallback: fallbackFor(everyPathButTheHosts) });
      const sent = await send(host, { path: target });
      expect(sent).toMatchObject({ status: 200, body: "handled" });
      expect(asked).toEqual([resolved.split("?")[0]]);
      expect(fellBack).toEqual([]);
      expect(seen.map((request) => request.url)).toEqual([
        `http://requestport.test${resolved}`,
      ]);
    },
  );

  test("a dot-segment target that resolves to a path the fallback serves reaches it as the resolved path and query, the path it was asked about", async () => {
    const host = await start({ fallback: fallbackFor(everyPathButTheHosts) });
    const sent = await send(host, { path: "/api/../sign-in?next=%2Fprojects" });
    expect(sent).toMatchObject({ status: 200, body: "next" });
    expect(asked).toEqual(["/sign-in"]);
    expect(fellBack.map((request) => request.url)).toEqual([
      "/sign-in?next=%2Fprojects",
    ]);
    expect(seen).toEqual([]);
  });

  test("a dot segment that resolves to a trailing slash is redirected to the resolved path without it, and neither the fallback nor the handler is called", async () => {
    const host = await start({ fallback: fallbackFor(everyPathButTheHosts) });
    const sent = await send(host, { path: "/api/v1/projects/.?x=1" });
    expect(sent.status).toBe(308);
    expect(sent.headers.location).toBe(
      "http://requestport.test/api/v1/projects?x=1",
    );
    expect(asked).toEqual([]);
    expect(fellBack).toEqual([]);
    expect(seen).toEqual([]);
  });

  test("a body reaches it unread, from the socket", async () => {
    const host = await start({ fallback: fallbackFor("/settings") });
    const sent = await send(host, {
      method: "POST",
      path: "/settings/projects/new",
      headers: { "content-type": "text/plain" },
      body: "name=one&slug=one",
    });
    expect(sent.status).toBe(200);
    expect(fellBack).toMatchObject([
      { method: "POST", body: "name=one&slug=one" },
    ]);
    expect(seen).toEqual([]);
  });

  test("TRACE on a path it serves: 501, and it is not called", async () => {
    const host = await start({ fallback: fallbackFor("/") });
    const sent = await send(host, { method: "TRACE", path: "/sign-in" });
    expect(sent.status).toBe(501);
    expect(fellBack).toEqual([]);
  });

  test("a fallback that throws before it answers: 500, and the next request is served", async () => {
    let calls = 0;
    const host = await start({
      fallback: fallbackFor("/", async (_incoming, outgoing) => {
        calls += 1;
        if (calls === 1) throw new Error("the fallback failed");
        outgoing.end("second");
      }),
    });
    const first = await send(host, { path: "/sign-in" });
    expect(first.status).toBe(500);
    const second = await send(host, { path: "/sign-in" });
    expect(second).toMatchObject({ status: 200, body: "second" });
  });

  test("a fallback that fails once it has answered part: the connection is closed, and the next request is served", async () => {
    let calls = 0;
    const host = await start({
      fallback: fallbackFor("/", async (_incoming, outgoing) => {
        calls += 1;
        if (calls === 1) {
          outgoing.writeHead(200, { "content-length": "10" });
          outgoing.write("part");
          throw new Error("the fallback failed part-way");
        }
        outgoing.end("whole");
      }),
    });
    await expect(send(host, { path: "/sign-in" })).rejects.toThrow();
    const second = await send(host, { path: "/sign-in" });
    expect(second).toMatchObject({ status: 200, body: "whole" });
  });
});
