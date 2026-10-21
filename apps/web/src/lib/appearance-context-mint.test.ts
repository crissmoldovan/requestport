import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  APPEARANCE_RENDER_CONTEXT_ENDPOINT,
  appearanceRenderContextExpiryMarginSeconds,
  appearanceRenderContextMaxLength,
  appearanceRenderContextTtlSeconds,
  appearanceRenderContextUsable,
  createAppearanceRenderContextRoute,
  fetchPersonalAppearanceRenderContext,
} from "./appearance-context-mint.js";
import {
  appearanceFormContextMaxLength,
  appearanceFormContextTtlSeconds,
  createPersonalAppearanceFormContext,
} from "./appearance-form-context.js";

const token = "v1.eyJhIjoiYWN0b3IifQ.c2lnbmF0dXJl";
const sourceRoot = resolve(import.meta.dirname, "..");
const secret = "appearance-context-mint-suite-secret-0001";
const now = Date.UTC(2026, 7, 27, 12, 0, 0);

/** A real token, sealed at `issuedAt`, so the reader is read on the real shape. */
function issued(issuedAt: number) {
  return createPersonalAppearanceFormContext({
    actorId: "00000000-0000-4000-8000-0000000000aa",
    issuedAt,
    secret,
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("personal render-context mint", () => {
  test("posts to the endpoint and returns the freshly minted token", async () => {
    const send = vi.fn(async () => jsonResponse({ token }));

    await expect(fetchPersonalAppearanceRenderContext(send)).resolves.toBe(
      token,
    );
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(APPEARANCE_RENDER_CONTEXT_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
  });

  test.each([
    ["a transport failure", async () => Promise.reject(new Error("offline"))],
    ["a body that is not JSON", async () => new Response("<html>proxy</html>")],
    ["a body with no token", async () => jsonResponse({ ok: true })],
    ["a token that is not a string", async () => jsonResponse({ token: 7 })],
    ["an empty token", async () => jsonResponse({ token: "" })],
    [
      "a token longer than the verifier will read",
      async () =>
        jsonResponse({
          token: "v".repeat(appearanceRenderContextMaxLength + 1),
        }),
    ],
  ])("keeps the rendered token when the mint answers %s", async (_n, send) => {
    await expect(
      fetchPersonalAppearanceRenderContext(send),
    ).resolves.toBeNull();
  });

  test("gives up rather than leaving the menu waiting on a mint", async () => {
    // A hung mint must not be able to hold the panel: the caller falls back to
    // the token the document was rendered with, which is exactly the behaviour
    // this fix replaced — never a control that can no longer be pressed.
    const never = () => new Promise<Response>(() => {});

    await expect(
      fetchPersonalAppearanceRenderContext(never, 10),
    ).resolves.toBeNull();
  });

  test("reads the same token length the verifier does", () => {
    expect(appearanceRenderContextMaxLength).toBe(
      appearanceFormContextMaxLength,
    );
  });

  test("reads the same lifetime the verifier does", () => {
    expect(appearanceRenderContextTtlSeconds).toBe(
      appearanceFormContextTtlSeconds,
    );
  });
});

/**
 * Whether the token in the reader's hand is still worth submitting.
 *
 * The sealed payload's issue time is not a secret — it is base64url JSON, and
 * every holder of a token can read it. Reading it decides nothing about trust:
 * the signature, the actor and the tenant are still checked by the server and
 * only by the server. It decides one thing the client is in a position to know
 * on its own, which is whether the submission it is about to make has already
 * expired. Submitting one that has is how a tab left open past the fifteen
 * minutes gets `context_conflict` — "reload the page and try again" — from the
 * control whose whole point is not having to.
 */
describe("a render context the tab has kept", () => {
  test("is usable while the verifier would still accept it", () => {
    expect(appearanceRenderContextUsable(issued(now), now)).toBe(true);
  });

  test("stops being usable a margin before the verifier drops it", () => {
    const margin = appearanceRenderContextExpiryMarginSeconds;
    const expiring = now - (appearanceRenderContextTtlSeconds - margin) * 1_000;

    // The submission has to travel, so the client gives up on a token with
    // less than the margin left rather than spending a round trip to be told.
    expect(appearanceRenderContextUsable(issued(expiring), now)).toBe(false);
    expect(appearanceRenderContextUsable(issued(expiring + 2_000), now)).toBe(
      true,
    );
  });

  test("is unusable once the tab has outlived it", () => {
    const stale = now - (appearanceRenderContextTtlSeconds + 60) * 1_000;

    expect(appearanceRenderContextUsable(issued(stale), now)).toBe(false);
  });

  test.each([
    ["nothing at all", ""],
    ["a token of the wrong shape", "v1.render.context"],
    ["an unknown version", issued(now).replace(/^v1\./u, "v2.")],
    ["a payload that is not JSON", "v1.bm90LWpzb24.c2ln"],
    ["a payload with no issue time", "v1.eyJhIjoiYWN0b3IiLCJvIjpudWxsfQ.c2ln"],
    ["a token longer than the verifier reads", `v1.${"a".repeat(600)}.c2ln`],
  ])("is unusable when the tab holds %s", (_name, held) => {
    // Unreadable is not the same as forged — the server still decides that —
    // but a token this side cannot read is one it cannot vouch for either, so
    // it is minted again rather than spent.
    expect(appearanceRenderContextUsable(held, now)).toBe(false);
  });
});

describe("personal render-context route handler", () => {
  test("answers with a token minted for the authenticated actor, uncached", async () => {
    const mintPersonalContext = vi.fn(async () => token);
    const route = createAppearanceRenderContextRoute({ mintPersonalContext });

    const response = await route.POST();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ token });
    expect(mintPersonalContext).toHaveBeenCalledTimes(1);
  });

  test("redacts a failed mint behind a token-less answer", async () => {
    const route = createAppearanceRenderContextRoute({
      mintPersonalContext: async () => {
        throw new Error("postgres://secret@host session lookup");
      },
    });

    const response = await route.POST();
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).not.toContain("secret");
    expect(JSON.parse(body)).toEqual({ token: null });
  });

  test("serves the endpoint from the route handler its own path names", () => {
    const handler = resolve(
      sourceRoot,
      "app",
      `${APPEARANCE_RENDER_CONTEXT_ENDPOINT.replace(/^\//u, "")}/route.ts`,
    );
    const source = readFileSync(handler, "utf8");

    expect(source).toContain("createAppearanceRenderContextRoute");
    expect(source).toContain("createPersonalAppearanceRenderContext");
  });
});
