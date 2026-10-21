import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getDefaultAutoSelectFamily } from "node:net";

import { afterEach, describe, expect, test } from "vitest";

import { postPinned } from "./pinned-post.js";

/*
 * A real socket, under Node's own defaults. Node 22 turns family
 * autoselection on by default, and with it asks the request's `lookup` for
 * every address (`all: true`); a lookup that only answers the one-address
 * form makes every POST fail before a socket opens, with "Invalid IP address:
 * undefined". No other test here opens a socket, so this is the one that
 * notices.
 */
let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve(),
  );
  server = undefined;
});

async function receiver() {
  const seen: Array<{ method?: string; url?: string; host?: string }> = [];
  server = createServer((request: IncomingMessage, response) => {
    seen.push({
      method: request.method,
      url: request.url,
      host: request.headers.host,
    });
    request.resume();
    request.on("end", () => {
      response.statusCode = 204;
      response.end();
    });
  });
  await new Promise<void>((resolve) =>
    server?.listen(0, "127.0.0.1", () => resolve()),
  );
  return { port: (server.address() as AddressInfo).port, seen };
}

describe("postPinned, over a real socket", () => {
  test("Node's default autoselection is on here, as on Node 22 everywhere this runs", () => {
    expect(getDefaultAutoSelectFamily()).toBe(true);
  });

  test("posts to the pinned address, not to what the hostname resolves to, with autoselection on", async () => {
    const { port, seen } = await receiver();
    const response = await postPinned({
      // receiver.test does not resolve; only the pin can reach the server.
      url: new URL(`http://receiver.test:${port}/hook`),
      address: "127.0.0.1",
      family: 4,
      body: new TextEncoder().encode('{"ok":true}'),
      headers: { "content-type": "application/json" },
      timeoutMs: 5_000,
    });

    expect(response.status).toBe(204);
    expect(seen).toEqual([
      { method: "POST", url: "/hook", host: `receiver.test:${port}` },
    ]);
  });
});
