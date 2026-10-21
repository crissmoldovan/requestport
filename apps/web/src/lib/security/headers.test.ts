import { describe, expect, test } from "vitest";

import { requestSecurityHeaders } from "./headers.js";

const nonce = "0123456789abcdef0123456789abcdef";

function directives(
  input: {
    production?: boolean;
    canonicalProductionHost?: boolean;
    upgradeInsecureRequests?: boolean;
  } = {},
) {
  const headers = requestSecurityHeaders({
    nonce,
    production: input.production ?? true,
    canonicalProductionHost: input.canonicalProductionHost ?? false,
    ...(input.upgradeInsecureRequests === undefined
      ? {}
      : { upgradeInsecureRequests: input.upgradeInsecureRequests }),
  });
  const entries = headers["content-security-policy"]
    .split("; ")
    .map((directive) => {
      const [name, ...values] = directive.split(" ");
      return [name, values.join(" ")] as const;
    });

  return new Map(entries);
}

describe("CUE++ inline-style CSP split", () => {
  test("keeps the fallback style-src at 'self' with no inline or nonce source", () => {
    expect(directives().get("style-src")).toBe("'self'");
  });

  test("restricts stylesheet elements to 'self' plus the request nonce", () => {
    expect(directives().get("style-src-elem")).toBe(`'self' 'nonce-${nonce}'`);
    expect(directives().get("style-src-elem")).not.toContain("unsafe-inline");
  });

  test("permits inline style attributes for CUE++ component styles only", () => {
    expect(directives().get("style-src-attr")).toBe("'unsafe-inline'");
  });

  test("never lets a script gain an inline source", () => {
    for (const production of [true, false]) {
      const script = directives({ production }).get("script-src");

      expect(script).toContain(`'nonce-${nonce}'`);
      expect(script).toContain("'strict-dynamic'");
      expect(script).not.toContain("unsafe-inline");
    }

    expect(directives({ production: false }).get("script-src")).toContain(
      "'unsafe-eval'",
    );
    expect(directives({ production: true }).get("script-src")).not.toContain(
      "unsafe-eval",
    );
  });

  test("declares the three style directives exactly once, in a fixed order", () => {
    const policy = requestSecurityHeaders({
      nonce,
      production: true,
      canonicalProductionHost: false,
    })["content-security-policy"];
    const order = policy
      .split("; ")
      .map((directive) => directive.split(" ")[0])
      .filter((name) => name?.startsWith("style-src"));

    expect(order).toEqual(["style-src", "style-src-elem", "style-src-attr"]);
  });

  test("leaves every other locked directive unchanged", () => {
    const policy = directives();

    expect(policy.get("default-src")).toBe("'self'");
    expect(policy.get("img-src")).toBe("'self' data: https:");
    expect(policy.get("font-src")).toBe("'self' data:");
    expect(policy.get("connect-src")).toBe("'self' https: wss:");
    expect(policy.get("frame-ancestors")).toBe("'none'");
    expect(policy.get("object-src")).toBe("'none'");
    expect(policy.get("base-uri")).toBe("'self'");
    expect(policy.get("form-action")).toBe(
      "'self' https://github.com https://slack.com",
    );
    expect(policy.has("upgrade-insecure-requests")).toBe(true);
    expect(
      directives({ production: false }).has("upgrade-insecure-requests"),
    ).toBe(false);
  });

  test("keeps the remaining response headers and HSTS rule intact", () => {
    const headers = requestSecurityHeaders({
      nonce,
      production: true,
      canonicalProductionHost: true,
    });

    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["strict-transport-security"]).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
    expect(
      requestSecurityHeaders({
        nonce,
        production: true,
        canonicalProductionHost: false,
      })["strict-transport-security"],
    ).toBeUndefined();
  });
});

/**
 * The one directive that asks a browser to change the transport.
 *
 * `upgrade-insecure-requests` is the only part of this policy that cannot be
 * satisfied by the origin the acceptance lanes drive: they serve a built
 * application over plain loopback, and a browser that honours the directive
 * there asks for every asset over TLS that nothing is listening for. WebKit
 * does honour it on loopback where Chromium exempts it — CI run 33487078113
 * recorded 112 `Error performing TLS handshake` lines and seventeen of
 * eighteen WebKit cases failing on a page whose script never loaded.
 *
 * So it is separable from the rest of the production policy, and only it. The
 * `production` flag still decides `script-src`, which is what keeps the lanes
 * exercising the policy the application actually ships — a run that dropped
 * `production` wholesale would quietly hand itself `'unsafe-eval'` and stop
 * testing the directive that matters most.
 */
describe("the transport-upgrade directive", () => {
  test("is present for a production policy by default", () => {
    expect([...directives({ production: true }).keys()]).toContain(
      "upgrade-insecure-requests",
    );
  });

  test("is absent for a non-production policy", () => {
    expect([...directives({ production: false }).keys()]).not.toContain(
      "upgrade-insecure-requests",
    );
  });

  test("can be withheld from a production policy on its own", () => {
    const withheld = directives({
      production: true,
      upgradeInsecureRequests: false,
    });

    expect([...withheld.keys()]).not.toContain("upgrade-insecure-requests");
    // Everything else the production policy decides is untouched, which is the
    // whole point of separating them: the lane keeps the production
    // `script-src`, without `'unsafe-eval'`.
    expect(withheld.get("script-src")).toBe(
      `'self' 'nonce-${nonce}' 'strict-dynamic'`,
    );
    expect(withheld.get("script-src")).not.toContain("unsafe-eval");
  });

  test("cannot be granted to a non-production policy", () => {
    // Planted: the withholding is one-way. A flag that could also *add* the
    // directive would let a development policy ask a browser for a transport
    // it does not have.
    expect([
      ...directives({
        production: false,
        upgradeInsecureRequests: true,
      }).keys(),
    ]).not.toContain("upgrade-insecure-requests");
  });
});
