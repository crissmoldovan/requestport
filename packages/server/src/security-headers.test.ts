import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  requestSecurityHeaders,
  upgradeInsecureRequestsFor,
} from "./security-headers.js";

type OriginRuleRow = {
  url: string;
  accepted: boolean;
  kind: string;
  why: string;
};

/**
 * The table the issuer's rule and the client's binding are held to, read by
 * relative path as `packages/auth` reads it: this package does not import
 * `packages/client` (manifest-h.md §2.8.1).
 */
const originRule = JSON.parse(
  readFileSync(
    new URL("../../client/src/origin-rule.cases.json", import.meta.url),
    "utf8",
  ),
) as { cases: OriginRuleRow[] };

/**
 * The refusals that are about a URL's user name, password, query or fragment.
 * The directive's rule reads only the scheme and the host, so on these rows it
 * answers as it would for the same URL without them.
 */
const refusedForAnotherPart = new Set([
  "userinfo",
  "password-only",
  "username-only",
  "query",
  "empty-query",
  "fragment",
  "empty-fragment",
]);

describe("upgradeInsecureRequestsFor: the public URL's rule for upgrade-insecure-requests (H.5)", () => {
  test("drops the directive for http on a loopback host, and keeps it for https, for production's URL and for http elsewhere", () => {
    expect(upgradeInsecureRequestsFor("http://127.0.0.1:3200")).toBe(false);
    expect(upgradeInsecureRequestsFor("http://localhost:3000")).toBe(false);
    expect(upgradeInsecureRequestsFor("http://[::1]:3200")).toBe(false);
    expect(upgradeInsecureRequestsFor("https://requestport.com")).toBe(true);
    expect(upgradeInsecureRequestsFor("https://127.0.0.1:3200")).toBe(true);
    expect(upgradeInsecureRequestsFor("http://rp.internal:3200")).toBe(true);
  });

  test("keeps the directive for a URL that is unset, empty or does not parse", () => {
    expect(upgradeInsecureRequestsFor(undefined)).toBe(true);
    expect(upgradeInsecureRequestsFor("")).toBe(true);
    expect(upgradeInsecureRequestsFor("127.0.0.1:3200")).toBe(true);
    expect(upgradeInsecureRequestsFor("http://")).toBe(true);
  });

  test("names the issuer rule's loopback hosts, row by row of origin-rule.cases.json", () => {
    const judged = originRule.cases.map((row) => {
      const http = row.url.startsWith("http:");
      const expected = refusedForAnotherPart.has(row.kind)
        ? !http
        : row.kind !== "loopback";
      return {
        url: row.url,
        kind: row.kind,
        expected,
        answered: upgradeInsecureRequestsFor(row.url),
      };
    });

    expect(
      judged.filter(({ expected, answered }) => expected !== answered),
    ).toEqual([]);
    // Every kind the table holds is judged above, and each answer is seen.
    expect(new Set(judged.map(({ kind }) => kind))).toEqual(
      new Set([
        "origin",
        "loopback",
        "host",
        "scheme",
        "not-a-url",
        ...refusedForAnotherPart,
      ]),
    );
    expect(new Set(judged.map(({ answered }) => answered))).toEqual(
      new Set([true, false]),
    );
  });

  test("every http URL the issuer rule accepts drops the directive, and every https one keeps it", () => {
    const accepted = originRule.cases.filter((row) => row.accepted);

    expect(accepted.length).toBeGreaterThan(0);
    for (const row of accepted) {
      expect(upgradeInsecureRequestsFor(row.url), row.url).toBe(
        !row.url.startsWith("http:"),
      );
    }
  });

  test("its answer, handed to a production policy, is whether the policy carries the directive", () => {
    for (const [url, carries] of [
      ["https://requestport.com", true],
      ["http://127.0.0.1:3200", false],
      [undefined, true],
    ] as const) {
      const policy = requestSecurityHeaders({
        nonce: "0123456789abcdef0123456789abcdef",
        production: true,
        canonicalProductionHost: false,
        upgradeInsecureRequests: upgradeInsecureRequestsFor(url),
      })["content-security-policy"];

      expect(policy.includes("upgrade-insecure-requests"), String(url)).toBe(
        carries,
      );
    }
  });
});
