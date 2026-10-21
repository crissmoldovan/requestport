import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { requestSecurityHeaders } from "./lib/security/headers.js";
import { config, proxy } from "./proxy.js";

/**
 * The names Next.js uses to carry request-header overrides back out of a
 * proxy. `NextResponse.next({ request: { headers } })` has no public reader,
 * so what the render will actually receive is read off the response the same
 * way the framework reads it.
 */
const OVERRIDDEN = "x-middleware-override-headers";
const overrideOf = (name: string) => `x-middleware-request-${name}`;

function respond(url = "https://staging.requestport.com/settings/appearance") {
  return proxy(new NextRequest(url));
}

function forwardedNonce(response: Response) {
  return response.headers.get(overrideOf("x-nonce"));
}

describe("proxy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("mints a different nonce for every single response", () => {
    const nonces = Array.from({ length: 64 }, () => forwardedNonce(respond()));

    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[0-9a-f]{32}$/u);
    }
    expect(new Set(nonces).size).toBe(nonces.length);
  });

  /**
   * `script-src` carries `'strict-dynamic'`, which makes a browser ignore the
   * `'self'` beside it. The per-response nonce is therefore the only thing
   * authorising any script on the page, and a nonce that repeats across
   * responses is a nonce an attacker can learn from one response and reuse in
   * the next.
   */
  it("authorises scripts with the nonce it just minted and no other source", () => {
    const seen = new Set<string>();

    for (let attempt = 0; attempt < 64; attempt += 1) {
      const response = respond();
      const nonce = forwardedNonce(response);
      const policy = response.headers.get("content-security-policy") ?? "";
      const directive = policy
        .split("; ")
        .find((entry) => entry.startsWith("script-src "));

      expect(nonce).not.toBeNull();
      expect(directive).toContain(`'nonce-${nonce}'`);
      expect(directive).toContain("'strict-dynamic'");
      expect(seen.has(directive ?? "")).toBe(false);
      seen.add(directive ?? "");
    }
  });

  it("forwards the nonce and the policy it belongs to into the render", () => {
    const response = respond();
    const nonce = forwardedNonce(response);
    const overridden = (response.headers.get(OVERRIDDEN) ?? "").split(",");

    expect(overridden).toContain("x-nonce");
    expect(overridden).toContain("content-security-policy");
    expect(response.headers.get(overrideOf("content-security-policy"))).toBe(
      response.headers.get("content-security-policy"),
    );
    expect(nonce).toMatch(/^[0-9a-f]{32}$/u);
  });

  // A header the proxy forgets is a header no route can add back: this is the
  // only place any of them is set.
  it("applies exactly the security headers the policy defines", () => {
    for (const [host, production] of [
      ["https://staging.requestport.com/dashboard", false],
      ["https://requestport.com/dashboard", false],
      ["https://requestport.com/dashboard", true],
      ["https://staging.requestport.com/dashboard", true],
    ] as const) {
      vi.stubEnv("NODE_ENV", production ? "production" : "test");
      // Each deployment's public URL is the https origin it serves, which
      // keeps upgrade-insecure-requests; the cases below hold the others.
      vi.stubEnv("BETTER_AUTH_URL", new URL(host).origin);
      const response = proxy(new NextRequest(host));
      const nonce = forwardedNonce(response);
      expect(nonce).not.toBeNull();

      const expected = requestSecurityHeaders({
        canonicalProductionHost: new URL(host).hostname === "requestport.com",
        nonce: nonce as string,
        production,
      });

      for (const [name, value] of Object.entries(expected)) {
        expect(response.headers.get(name), `${host} ${name}`).toBe(value);
      }
      expect(
        response.headers.has("strict-transport-security"),
        `${host} hsts`,
      ).toBe("strict-transport-security" in expected);
    }
  });

  /**
   * The public URL's rule (Plan 13, H.5; manifest-h.md §2.3), in a production
   * build, where `NODE_ENV` is `production` and the end-to-end fence is shut:
   * an http `BETTER_AUTH_URL` on a loopback host, such as `requestport
   * start`'s default `http://127.0.0.1:3200`, drops `upgrade-insecure-requests`,
   * which WebKit honours on loopback (K5). An https one keeps it, and
   * production's is `https://requestport.com`. An unset one keeps it too.
   */
  describe("upgrade-insecure-requests in a production build, by the runtime BETTER_AUTH_URL", () => {
    function policyFor(url: string, publicUrl: string | undefined) {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("BETTER_AUTH_URL", publicUrl);
      return (
        proxy(new NextRequest(url)).headers.get("content-security-policy") ?? ""
      );
    }

    it("keeps it for an https public URL, production's", () => {
      expect(
        policyFor(
          "https://requestport.com/dashboard",
          "https://requestport.com",
        ),
      ).toContain("upgrade-insecure-requests");
    });

    it("drops it for an http public URL on a loopback host", () => {
      const policy = policyFor(
        "http://127.0.0.1:3200/dashboard",
        "http://127.0.0.1:3200",
      );

      expect(policy).not.toContain("upgrade-insecure-requests");
      // Only the directive: the rest of the production policy stays.
      expect(policy).toContain("script-src 'self' 'nonce-");
      expect(policy).not.toContain("unsafe-eval");
    });

    it("keeps it when BETTER_AUTH_URL is unset", () => {
      expect(policyFor("http://127.0.0.1:3200/dashboard", undefined)).toContain(
        "upgrade-insecure-requests",
      );
    });
  });

  /**
   * Every response this proxy touches is a signed-in document or an API answer
   * derived from one. A shared cache that kept any of them would serve one
   * tenant's page to the next viewer, so the store is refused rather than
   * merely revalidated.
   */
  it("refuses to let any answer it guards be stored", () => {
    expect(respond().headers.get("cache-control")).toBe("private, no-store");
    expect(
      respond("https://staging.requestport.com/api/health/ready").headers.get(
        "cache-control",
      ),
    ).toBe("private, no-store");
  });

  // Immutable build output is the one thing that must stay cacheable, and the
  // matcher already keeps it out; the runtime carve-out is what holds if a
  // request reaches here anyway.
  it("leaves immutable build output cacheable", () => {
    for (const path of ["/_next/static/chunk.js", "/_next/image/x.png"]) {
      const response = respond(`https://staging.requestport.com${path}`);
      expect(response.headers.has("cache-control"), path).toBe(false);
      expect(
        response.headers.get("content-security-policy"),
        path,
      ).not.toBeNull();
    }
  });

  it("declares a matcher that keeps build output out of this proxy", () => {
    expect(config.matcher).toEqual([
      "/((?!_next/static|_next/image|favicon.ico).*)",
    ]);
    const [matcher] = config.matcher;
    const pattern = new RegExp(`^${matcher}$`, "u");
    for (const path of [
      "/_next/static/chunk.js",
      "/_next/image/x.png",
      "/favicon.ico",
    ]) {
      expect(pattern.test(path), path).toBe(false);
    }
    for (const path of ["/", "/dashboard", "/api/health/ready"]) {
      expect(pattern.test(path), path).toBe(true);
    }
  });
});
