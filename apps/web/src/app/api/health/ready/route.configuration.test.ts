import { afterEach, expect, test, vi } from "vitest";

/*
 * The readiness route in a process whose server configuration does not
 * parse (Plan 13, G.6; ruling 140; manifest-g.md §7, Done when 4). Nothing is
 * replaced here: the route, the web root it imports and the configuration
 * load as themselves. The route reads the configuration only inside its
 * handler, and the web root's module imports nothing that parses it, so the
 * route still loads, and the probe answers 503 `{ ready: false }` rather than
 * failing as it loads. `route.test.ts` holds the route's other answers, over
 * a stand-in root.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

test("loads, and answers 503 { ready: false }, in a process whose server configuration does not parse", async () => {
  // Shorter than the 32 characters the configuration requires.
  vi.stubEnv("BETTER_AUTH_SECRET", "too-short");
  vi.resetModules();

  await expect(import("@requestport/config/server")).rejects.toMatchObject({
    name: "ZodError",
  });

  const { GET } = await import("./route.js");
  const response = await GET();

  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ ready: false });
  expect(response.headers.get("cache-control")).toBe("no-store");
});
