import { once } from "node:events";
import { connect, type Socket } from "node:net";
import { clearTimeout, setTimeout } from "node:timers";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  type CallbackServer,
  CallbackServerError,
  type CallbackServerOptions,
  DEFAULT_CALLBACK_PATH,
  DEFAULT_TIMEOUT_MS,
  startCallbackServer,
} from "./callback-server.js";
import { readCallback } from "./oauth.js";

/**
 * A real socket, because the socket is the thing under test.
 *
 * Every other suite in this package injects its side effect and drives a stub,
 * and that is the right shape when the side effect is a request to somebody
 * else's server. Here the side effect *is* the subject: which interface it
 * binds, whether the port comes back, whether it stops listening afterwards.
 * A stubbed `node:http` would prove only that the stub agrees with itself.
 *
 * Nothing here leaves the machine. No name is resolved, no packet reaches an
 * interface a router can see, and the whole conversation is this process
 * talking to itself over 127.0.0.1 — which is the distinction that matters,
 * not whether the word "server" appears.
 */

/** Distinctive, so any fragment of them surfacing anywhere is unmistakable. */
const CODE = "authcode-4f7b-do-not-echo-me";
const STATE = "state-91ce-do-not-echo-me";

/**
 * A leak is not only the whole value.
 *
 * Six characters of an authorization code is six an attacker no longer has to
 * guess, and the usual accidents — a parser quoting its input, a template
 * dropping the query into a page — disclose a run rather than the lot. An
 * assertion that catches only a total disclosure lets every partial one
 * through.
 */
const RECOGNISABLE = 6;

function expectNoTraceOf(secret: string, text: string): void {
  for (const form of encodings(secret)) {
    for (let at = 0; at + RECOGNISABLE <= form.length; at += 1) {
      expect(text).not.toContain(form.slice(at, at + RECOGNISABLE));
    }
  }
}

/**
 * The shapes a secret can take on its way out.
 *
 * A raw-substring assertion is escaped by any encoding, and the adversarial
 * review of 2026-09-06 proved it: a mutation that base64'd the query into the
 * page passed the whole suite while leaking every character of the code. The
 * encodings a leak plausibly travels in are therefore checked too, so
 * "it is not in there verbatim" stops being mistaken for "it is not in there".
 */
function encodings(secret: string): string[] {
  return [
    secret,
    ...base64Alignments(secret),
    Buffer.from(secret).toString("hex"),
    encodeURIComponent(secret),
  ];
}

/**
 * Base64 of the secret as it appears at each of the three byte alignments.
 *
 * Base64 encodes three bytes at a time, so a secret that starts one or two
 * bytes into a larger string produces completely different characters. The
 * first version of this helper encoded the secret in isolation and therefore
 * only recognised it at alignment zero — the audit escaped it in one line by
 * prefixing two bytes before encoding, which leaked the whole query with the
 * suite green.
 *
 * Each alignment is encoded with padding bytes in front and the first four
 * characters dropped, which removes the groups those padding bytes contaminate
 * and leaves the part that is stable wherever the secret sits.
 */
function base64Alignments(secret: string): string[] {
  const forms: string[] = [];

  for (const pad of ["", "x", "xy"]) {
    for (const encoding of ["base64", "base64url"] as const) {
      forms.push(
        Buffer.from(pad + secret)
          .toString(encoding)
          .slice(4),
      );
    }
  }

  return forms;
}

/**
 * Everything the listener said, not only the part a browser renders.
 *
 * The review also escaped the body-only assertion by putting the query in a
 * response header, which is on the wire and in every proxy log between here and
 * the browser. Headers are part of what was disclosed, so they are part of what
 * is checked.
 */
async function everythingSaid(response: Response): Promise<string> {
  const headers = [...response.headers.entries()]
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");

  return `${headers}\n${await response.text()}`;
}

/**
 * What a person would actually see, which includes the cause chain.
 *
 * Node prints causes by default, so an error that merely *carries* the failure
 * it wrapped discloses exactly as much as one that quotes it.
 */
async function rejectionText(wait: Promise<unknown>): Promise<string> {
  try {
    await wait;
  } catch (error) {
    const chain: string[] = [];
    let current: unknown = error;

    for (let depth = 0; current !== undefined && depth < 5; depth += 1) {
      chain.push(String(current));
      current = current instanceof Error ? current.cause : undefined;
    }

    return chain.join(" ");
  }

  throw new Error("the wait was expected to reject, and it did not");
}

/**
 * Everything this process says out loud, for the duration of a flow.
 *
 * The review escaped every body and header assertion in this file with a single
 * `console.error` of the callback url: stderr is a disclosure channel with the
 * widest audience of the lot — the terminal, the ci log, and the scrollback of
 * whoever is watching. `console` is captured as well as the streams under it,
 * because the test runner replaces the former and a leak would go out through
 * whichever one is still real.
 */
function captureOutput(said: string[]): () => void {
  const original = {
    debug: console.debug,
    dir: console.dir,
    error: console.error,
    info: console.info,
    log: console.log,
    trace: console.trace,
    warn: console.warn,
  };
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);

  const spoke = (...args: unknown[]): void => {
    said.push(args.map(String).join(" "));
  };
  const wrote = (chunk: unknown, ...rest: unknown[]): boolean => {
    said.push(String(chunk));
    // Whatever asked to write is waiting on this, and a swallowed callback is a
    // hung test rather than a failed one.
    const done = rest.find((argument) => typeof argument === "function");
    if (typeof done === "function") done();

    return true;
  };

  console.debug = spoke;
  console.dir = spoke;
  console.error = spoke;
  console.info = spoke;
  console.log = spoke;
  console.trace = spoke;
  console.warn = spoke;
  process.stdout.write = wrote as typeof process.stdout.write;
  process.stderr.write = wrote as typeof process.stderr.write;

  return () => {
    Object.assign(console, original);
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  };
}

/** Timers, because a deadline nobody cleared holds the process open. */
function pendingTimers(): number {
  return process.getActiveResourcesInfo().filter((kind) => kind === "Timeout")
    .length;
}

/**
 * This file's own waits take their timers from `node:timers`, which a fake
 * clock installed on the global does not reach, so they keep real time while
 * `holdDeadlines` is holding the listener's.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const running: CallbackServer[] = [];
const opened: Socket[] = [];

/**
 * A socket of our own, because some of what this module promises is about the
 * connection rather than the response: which of them survive the flow, and what
 * the head on the wire says. `fetch` can express neither — undici hides the
 * hop-by-hop headers, and it will not leave a request half-sent.
 */
async function connected(server: CallbackServer): Promise<Socket> {
  const socket = connect(server.port, server.host);
  // Being destroyed by the listener is the behaviour under test, so the reset
  // it arrives as is not a failure.
  socket.on("error", () => {});
  opened.push(socket);
  await once(socket, "connect");

  return socket;
}

/**
 * A connection that has begun a request and will never finish it — a browser
 * that opened a socket, sent a line and went away. Node counts it as active
 * rather than idle, which is the whole reason `close` alone does not reap it.
 */
async function stalledConnection(server: CallbackServer): Promise<Socket> {
  const socket = await connected(server);
  socket.write(`GET ${server.path} HTTP/1.1\r\nHost: ${server.host}\r\n`);
  // Given a moment to arrive: a connection the server has not read a byte from
  // is still idle, and idle is not the case being tested.
  await delay(25);

  return socket;
}

function closesWithin(socket: Socket, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const giveUp = setTimeout(() => resolve(false), ms);
    socket.once("close", () => {
      clearTimeout(giveUp);
      resolve(true);
    });
  });
}

/** The response head, verbatim, exactly as a browser would read it. */
async function responseHead(
  server: CallbackServer,
  target: string,
): Promise<string> {
  const socket = await connected(server);
  socket.write(
    `GET ${target} HTTP/1.1\r\nHost: ${server.host}:${server.port}\r\nConnection: keep-alive\r\n\r\n`,
  );

  return new Promise<string>((resolve, reject) => {
    let said = "";

    socket.on("data", (chunk) => {
      said += String(chunk);
      const end = said.indexOf("\r\n\r\n");
      if (end !== -1) resolve(said.slice(0, end));
    });
    socket.on("close", () => resolve(said));
    socket.on("error", reject);
  });
}

/** Registered for cleanup, so a failing assertion cannot leave a port held. */
async function listening(
  options: CallbackServerOptions = {},
): Promise<CallbackServer> {
  const server = await startCallbackServer(options);
  running.push(server);
  return server;
}

afterEach(() => {
  for (const server of running.splice(0)) server.close();
  for (const socket of opened.splice(0)) socket.destroy();
  vi.useRealTimers();
});

/**
 * The listener's deadline, held until the case releases it.
 *
 * A case about what happens when the wait gives up needs something in place
 * first — a request answered, a connection open and watched — and a deadline in
 * real time does not wait for it. The listener's timer and its accept share
 * this process's event loop, and libuv runs expired timers before it polls for
 * I/O. A worker the scheduler starves for longer than the deadline wakes up and
 * gives up first: a connection the kernel queued for it meanwhile is reset by
 * the listener's close (`connect ECONNRESET`), and one it accepted but has not
 * read yet is destroyed along with the rest (`read ECONNRESET`). Either way the
 * request fails before the assertion it exists for. A longer deadline only
 * raises the stall it takes: 30ms became 1s in #113, and a gate at load 43
 * still found a stall that long.
 *
 * So these cases fake the global `setTimeout`, which is how the listener sets
 * its deadline, and fire the deadline themselves once what it is meant to act
 * on exists. `fetch` still completes under the fake: the only global timer it
 * arms is undici's timeout tick, which drives its own timeouts, not the
 * request. This file's own waits take `node:timers`, which the fake does not
 * reach, so they keep real time.
 */
function holdDeadlines(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

function callbackUrl(server: CallbackServer): string {
  return `${server.redirectUri}?code=${CODE}&state=${STATE}`;
}

/**
 * "Still waiting" cannot be observed directly, so it is raced against a short
 * timer: if the wait settles first, the listener served something it should
 * have ignored.
 */
function stillWaiting(server: CallbackServer): Promise<boolean> {
  const settled = server.received.then(
    () => false,
    () => false,
  );
  const pending = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(true), 25);
  });

  return Promise.race([settled, pending]);
}

/**
 * Where the listener may be reached from, which is the whole of its security.
 *
 * RFC 8252 lets a public client take the authorization code over plain http
 * for exactly one reason: on the loopback interface "the network" is this
 * machine and nothing else. Bound to 0.0.0.0 the same listener hands the code
 * to anyone on the coffee-shop wifi who guesses a port, and every other
 * protection in the flow — PKCE, state — is downstream of that.
 */
describe("where the listener binds", () => {
  test("binds the loopback interface and nowhere else", async () => {
    const server = await listening();

    expect(server.host).toBe("127.0.0.1");
    expect(server.redirectUri).toBe(`http://127.0.0.1:${server.port}/callback`);
  });

  test("takes an ephemeral port and reports the one it was given", async () => {
    const first = await listening();
    const second = await listening();

    expect(first.port).toBeGreaterThan(0);
    expect(second.port).toBeGreaterThan(0);
    expect(first.port).not.toBe(second.port);
    expect(first.path).toBe(DEFAULT_CALLBACK_PATH);
  });

  test("uses a port it was handed, and refuses rather than moving", async () => {
    const held = await listening();

    // The port is taken, so this is the failure a caller must be told about:
    // quietly listening somewhere else would build a redirect_uri the
    // authorization server has never seen registered.
    await expect(listening({ port: held.port })).rejects.toThrow(
      CallbackServerError,
    );
  });

  test("serves a path a redirect can actually be registered for", async () => {
    await expect(listening({ path: "callback" })).rejects.toThrow(
      CallbackServerError,
    );
    await expect(listening({ path: "/callback?done=1" })).rejects.toThrow(
      CallbackServerError,
    );
    await expect(listening({ path: "/callback#done" })).rejects.toThrow(
      CallbackServerError,
    );

    const server = await listening({ path: "/oauth/done" });
    expect(server.redirectUri).toBe(
      `http://127.0.0.1:${server.port}/oauth/done`,
    );
  });

  test("waits long enough for a person to sign in", async () => {
    // A default measured in seconds would time out mid-consent, which reads to
    // a developer as a broken CLI rather than as a deadline they missed.
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);

    // And the constant is the deadline a listener with no `timeoutMs` actually
    // takes: the assertion above is about a number, this one about the wait.
    const server = await listening();
    await delay(250);

    expect(await stillWaiting(server)).toBe(true);
  });
});

/**
 * The redirect itself, which is the one message in the flow written by
 * something other than this process.
 */
describe("receiving the redirect", () => {
  test("resolves with the whole url the browser landed on", async () => {
    const server = await listening();

    await fetch(callbackUrl(server));
    const landed = await server.received;

    expect(landed).toBe(callbackUrl(server));
    // The url is handed straight to the reader that checks state and pulls the
    // code out, which is the only reason to keep the query intact.
    expect(readCallback(landed, { state: STATE })).toEqual({ code: CODE });
  });

  test("tells the person they are done and can close the tab", async () => {
    const server = await listening();

    const response = await fetch(callbackUrl(server));
    const body = await response.text();
    await server.received;

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/plain/u);
    expect(body).toMatch(/close this tab/iu);
  });

  test("never writes the query, the code or the state into the page", async () => {
    const server = await listening();

    const response = await fetch(callbackUrl(server));
    const said = await everythingSaid(response);
    await server.received;

    // The page is rendered by a browser, saved by a "save page as", and read
    // over a shoulder. It is the last place the code should appear, and the
    // easiest place to put it by accident while being helpful.
    expectNoTraceOf(CODE, said);
    expectNoTraceOf(STATE, said);
    expect(said).not.toContain("code=");
    expect(said).not.toContain("?");
  });

  test("serves exactly one callback and then gives the port back", async () => {
    const server = await listening();

    await fetch(callbackUrl(server));
    await server.received;

    // A listener that outlives the callback is a listener that accepts a
    // second, forged one — and holds a port on a developer's machine for the
    // rest of the session.
    await expect(fetch(server.redirectUri)).rejects.toThrow();
  });

  test("answers one callback per connection, even pipelined", async () => {
    const server = await listening();
    const socket = await connected(server);
    let said = "";
    socket.on("data", (chunk) => {
      said += String(chunk);
    });

    // Two callbacks in a single write, the second a forgery riding in behind
    // the first. Node parses both before either is answered, which is as close
    // as a request can get to being served after the wait has already settled.
    socket.write(
      `GET ${server.path}?code=${CODE} HTTP/1.1\r\nHost: h\r\n\r\nGET ${server.path}?code=forged HTTP/1.1\r\nHost: h\r\n\r\n`,
    );
    const landed = await server.received;
    await delay(150);

    expect(landed).toBe(`${server.redirectUri}?code=${CODE}`);
    // One status line, and it is the first request's. The forgery is never
    // answered and never reaches the caller.
    expect(said.split("HTTP/1.1 ").length - 1).toBe(1);
    expect(said).not.toContain("forged");
    expectNoTraceOf(CODE, said);
  });

  test("ignores a request to any other path, and keeps waiting", async () => {
    const server = await listening();

    const origin = `http://127.0.0.1:${server.port}`;
    const stray = await fetch(`${origin}/favicon.ico?code=${CODE}`);
    const body = await stray.text();

    expect(stray.status).toBe(404);
    expectNoTraceOf(CODE, body);
    expect(await stillWaiting(server)).toBe(true);

    // And the single use it was saving is still there for the real redirect.
    await fetch(callbackUrl(server));
    expect(await server.received).toBe(callbackUrl(server));
  });

  test("matches the callback path whole, and not by prefix", async () => {
    const server = await listening();

    // A path no authorization server was ever given and none will redirect to.
    // Taken for the callback by a prefix match, it spends the single use the
    // real redirect needs.
    const stray = await fetch(
      `http://127.0.0.1:${server.port}/callback-not-really?code=${CODE}&state=${STATE}`,
    );

    expect(stray.status).toBe(404);
    expectNoTraceOf(CODE, await everythingSaid(stray));
    expect(await stillWaiting(server)).toBe(true);
  });

  test("serves the redirect that carries a refusal, not only one with a code", async () => {
    const server = await listening();
    const denied = `${server.redirectUri}?error=access_denied&state=${STATE}`;

    await fetch(denied);

    // "The person said no" is an answer and the flow is over. A listener that
    // held out for a `code` would sit on the port until its deadline waiting
    // for a redirect that has already been and gone.
    expect(await server.received).toBe(denied);
  });

  test("tells the browser to hang up, and tells caches to forget", async () => {
    const server = await listening();

    const head = await responseHead(
      server,
      `${server.path}?code=${CODE}&state=${STATE}`,
    );
    await server.received;
    const said = head.toLowerCase();

    expect(said).toMatch(/^http\/1\.1 200/u);
    // Without `connection: close` the browser keeps the socket and the process
    // stays up holding one nobody is waiting on any more. `fetch` cannot see
    // this header — undici strips the hop-by-hop ones — which is why this test
    // speaks http itself rather than asserting nothing.
    expect(said).toContain("connection: close");
    // The url that reached this page had an authorization code in it, so no
    // part of the answer belongs in a cache.
    expect(said).toContain("cache-control: no-store");
    expectNoTraceOf(CODE, head);
  });

  test("says nothing on stdout or stderr, on either path", async () => {
    const said: string[] = [];
    const restore = captureOutput(said);

    try {
      const served = await listening();
      await fetch(`http://127.0.0.1:${served.port}/favicon.ico?code=${CODE}`);
      await fetch(callbackUrl(served));
      await served.received;

      const abandoned = await listening({ timeoutMs: 30 });
      await rejectionText(abandoned.received);
    } finally {
      restore();
    }

    // The review escaped every body and header assertion in this file with one
    // `console.error` of the callback url, and printing is the disclosure with
    // the widest audience: the terminal, the ci log, the scrollback. So the
    // assertion is "nothing", not "nothing recognisable".
    expect(said.join("")).toBe("");
  });

  test("leaves no timer running once the callback has been served", async () => {
    // A flow first, so the http client's own timers are already up and the
    // count below is about this module rather than about undici.
    const warmed = await listening();
    await fetch(callbackUrl(warmed));
    await warmed.received;

    const before = pendingTimers();
    const server = await listening();
    await fetch(callbackUrl(server));
    await server.received;

    // The deadline is a five-minute timer. Left pending after a *successful*
    // sign-in it holds the event loop open with nothing left to fire for, and
    // nothing later clears it — the caller's `close` is a no-op by then. The
    // CLI has its authorization code and hangs at exit.
    expect(pendingTimers()).toBeLessThanOrEqual(before);
  });

  test("drops a stalled connection once the callback has been served", async () => {
    const server = await listening();
    const stalled = await stalledConnection(server);
    const closed = closesWithin(stalled, 750);

    await fetch(callbackUrl(server));
    await server.received;

    // Node counts a half-sent request as active rather than idle, so `close`
    // leaves it — and `close` has already cleared the interval that enforces
    // the header timeout, so nothing else will ever reap it. The port comes
    // back regardless; this is the accepted socket, and it holds the event loop
    // open on the one path where nothing later cleans up.
    expect(await closed).toBe(true);
  });

  test("ignores anything that is not the browser following a redirect", async () => {
    const server = await listening();

    const posted = await fetch(server.redirectUri, {
      body: `code=${CODE}`,
      method: "POST",
    });

    expect(posted.status).toBe(404);
    expectNoTraceOf(CODE, await posted.text());
    expect(await stillWaiting(server)).toBe(true);
  });

  /**
   * The method guard, which the case above cannot reach.
   *
   * That POST carries its code in the *body*, so the listener refuses it for
   * looking nothing like an authorization response, before the method is ever
   * consulted — delete the method check and it still answers 404. This one
   * puts a real authorization response in the query string, so the only thing
   * left to refuse it on is the verb.
   *
   * What that guard is worth: a form on any page in the developer's browser
   * can POST cross-origin to a guessed loopback port. Without it, such a post
   * spends the listener's single use and hands the flow a callback url the
   * page chose. `readCallback` then fails on `state`, so the sign-in aborts
   * rather than being taken over — but the attempt is gone and the person is
   * left with a flow that will not complete.
   */
  test("refuses an authorization response that arrives by the wrong verb", async () => {
    const server = await listening();

    const posted = await fetch(`${server.redirectUri}?code=${CODE}&state=s`, {
      method: "POST",
    });

    expect(posted.status).toBe(404);
    expectNoTraceOf(CODE, await posted.text());
    expect(await stillWaiting(server)).toBe(true);
  });
});

/**
 * Both ways the wait ends without a redirect. Either one has to close the
 * socket: a CLI that gave up but left a listener on 127.0.0.1 is a port that
 * accepts an authorization code with nobody left to check its state.
 */
describe("giving up", () => {
  test("stops waiting after the timeout, and closes the socket", async () => {
    const server = await listening({ timeoutMs: 30 });

    await expect(server.received).rejects.toThrow(CallbackServerError);
    await expect(fetch(server.redirectUri)).rejects.toThrow();
  });

  test("stops waiting when the caller cancels, and closes the socket", async () => {
    const server = await listening();

    server.close();

    await expect(server.received).rejects.toThrow(CallbackServerError);
    await expect(fetch(server.redirectUri)).rejects.toThrow();
  });

  test("cancelling after the callback arrived changes nothing", async () => {
    const server = await listening();

    await fetch(callbackUrl(server));
    const landed = await server.received;
    server.close();
    server.close();

    expect(await server.received).toBe(landed);
  });

  test("refuses a timeout that is not a positive number of milliseconds", async () => {
    await expect(listening({ timeoutMs: 0 })).rejects.toThrow(
      CallbackServerError,
    );
    await expect(listening({ timeoutMs: -1 })).rejects.toThrow(
      CallbackServerError,
    );
  });

  test("refuses a timeout no timer can actually hold", async () => {
    // `setTimeout(fn, NaN)` fires almost at once and `setTimeout(fn, Infinity)`
    // is clamped to 1ms with a warning: both turn a caller's bad argument into
    // an instant sign-in failure quoting a deadline nothing honoured.
    await expect(listening({ timeoutMs: Number.NaN })).rejects.toThrow(
      CallbackServerError,
    );
    await expect(
      listening({ timeoutMs: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow(CallbackServerError);
    // Same clamp, one past the largest delay a 32-bit timer can express.
    await expect(listening({ timeoutMs: 2 ** 31 })).rejects.toThrow(
      CallbackServerError,
    );

    // And the largest one it can express is still a deadline, not a mistake.
    await expect(listening({ timeoutMs: 2 ** 31 - 1 })).resolves.toBeDefined();
  });

  test("rejects at the deadline it was given, and not at one of its own", async () => {
    const started = Date.now();
    const patient = await listening({ timeoutMs: 400 });
    const brief = await listening({ timeoutMs: 40 });

    await expect(brief.received).rejects.toThrow(CallbackServerError);
    const briefWaited = Date.now() - started;
    await expect(patient.received).rejects.toThrow(CallbackServerError);
    const patientWaited = Date.now() - started;

    // The numbers are the test. A listener that ignored the option and used a
    // constant of its own — 200ms, or the five-minute default — would still
    // "eventually reject", which is all the rest of this file asks of it, and a
    // CLI that abandoned every sign-in after a fifth of a second would ship.
    expect(briefWaited).toBeLessThan(300);
    expect(patientWaited).toBeGreaterThanOrEqual(350);
  });

  test("closes a connection that was already open when it gives up", async () => {
    holdDeadlines();
    const server = await listening({ timeoutMs: 60 });
    const stalled = await stalledConnection(server);
    // Watched before the deadline can fire: a socket that closes before
    // `closesWithin` is listening is one it never sees close, and the case
    // reads that as no close at all.
    const closed = closesWithin(stalled, 750);
    vi.advanceTimersByTime(60);

    await expect(server.received).rejects.toThrow(CallbackServerError);

    // `close` alone waits for a connection like this one, so the port — and the
    // process — would outlive the wait the caller has already given up on. A
    // new request being refused does not show this: that is true the moment the
    // listener stops accepting, whether or not the open socket was dropped.
    expect(await closed).toBe(true);
  });

  test("an abandoned wait does not take the process down", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", record);

    try {
      // `received` is deliberately never awaited here: a caller that raced this
      // against a cancel signal, or gave up on the sign-in, leaves exactly this
      // promise behind, and the deadline still passes.
      await listening({ timeoutMs: 30 });
      await delay(200);
    } finally {
      process.off("unhandledRejection", record);
    }

    // An unhandled rejection ends the process by default — on a path where the
    // CLI was doing nothing worse than giving up on a sign-in.
    expect(unhandled).toEqual([]);
  });

  test("reports an impossible option by rejecting, not by throwing", async () => {
    let wait: Promise<CallbackServer> | undefined;

    // A caller that awaits this should not also have to wrap it: a synchronous
    // throw is the failure the validation exists to prevent — a bad option
    // taking the process down instead of failing the sign-in.
    expect(() => {
      wait = startCallbackServer({ path: "callback" });
    }).not.toThrow();

    await expect(wait).rejects.toThrow(CallbackServerError);
  });

  test("no failure carries anything the browser sent", async () => {
    holdDeadlines();
    const server = await listening({ timeoutMs: 30 });

    const origin = `http://127.0.0.1:${server.port}`;
    await fetch(`${origin}/nope?code=${CODE}&state=${STATE}`);
    // Only now, with the request answered and so in scope, does the deadline
    // fire — however long the request took to be served.
    vi.advanceTimersByTime(30);
    const text = await rejectionText(server.received);

    expect(text).toContain("No authorization callback arrived within 30ms");

    // The request is in scope at the moment this rejects, and a timeout is
    // precisely the error a developer pastes into an issue asking why the
    // login hung.
    expectNoTraceOf(CODE, text);
    expectNoTraceOf(STATE, text);
  });
});

/**
 * Findings from the adversarial review of 2026-09-06, pinned so they cannot
 * come back.
 *
 * The port is guessable and the listener answers whatever reaches it, so every
 * one of these is reachable by an ordinary cross-origin `fetch` from a page in
 * another tab. None of them needs a raw socket or a privileged position.
 */
describe("what a hostile request cannot do", () => {
  /**
   * `new URL("//[/", origin)` throws, Node does not wrap the `request` emit,
   * and an uncaught `TypeError` there ended the host process. A sign-in was a
   * remote kill switch on whatever was waiting for it.
   */
  test.each([
    "//[/",
    "//[::1/callback",
    "//%/callback",
    "//a%20b/callback",
    "//:@/callback",
  ])(
    "cannot kill the process with the unparseable target %j",
    async (target) => {
      const server = await listening();

      const response = await fetch(
        `${server.redirectUri.replace(/\/callback$/u, "")}${target}`,
      ).catch(() => undefined);

      // Surviving to assert anything at all is most of the point.
      expect(response === undefined || response.status === 404).toBe(true);
      await expect(stillWaiting(server)).resolves.toBe(true);
      server.close();
    },
  );

  /**
   * A protocol-relative target keeps the expected pathname while parsing to a
   * different origin. It used to spend the single use and hand the caller a url
   * naming a host nobody here chose.
   */
  /**
   * The one hostile request no inspection of the connection can tell from the
   * real thing: when a page in another tab makes the browser fetch a guessed
   * loopback port, the browser really does connect, from this machine. Only the
   * shape of the query separates it from the redirect.
   */
  test("does not spend the single use on a request that is not a redirect", async () => {
    const server = await listening();

    const stray = await fetch(server.redirectUri);

    expect(stray.status).toBe(404);
    expect(await stillWaiting(server)).toBe(true);

    // Present but empty is absent: `readCallback` reads `code=` as no code, so
    // accepting it here would spend the single use on a request the reader is
    // going to refuse a moment later anyway.
    const empty = await fetch(`${server.redirectUri}?code=&error=`);

    expect(empty.status).toBe(404);
    expect(await stillWaiting(server)).toBe(true);

    // And the use it was saving is still there for the redirect that matters.
    await fetch(callbackUrl(server));
    expect(await server.received).toBe(callbackUrl(server));
  });

  test("does not accept a callback for another origin", async () => {
    const server = await listening();
    const base = server.redirectUri.replace(/\/callback$/u, "");

    const response = await fetch(
      `${base}//evil.example/callback?code=x&state=y`,
    );

    expect(response.status).toBe(404);
    await expect(stillWaiting(server)).resolves.toBe(true);
    server.close();
  });
});
