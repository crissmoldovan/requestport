import { readFileSync } from "node:fs";

import { hashLocalCredential } from "@requestport/domain";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, test, vi } from "vitest";

import { createAuthOptions } from "./server-options.js";

type OriginRuleRow = {
  url: string;
  accepted: boolean;
  kind: string;
  why: string;
};

/**
 * The table `packages/client` holds its binding to, read by relative path:
 * neither package may import the other (manifest-h.md §2.8.1).
 */
const originRule = JSON.parse(
  readFileSync(
    new URL("../../client/src/origin-rule.cases.json", import.meta.url),
    "utf8",
  ),
) as { cases: OriginRuleRow[] };

const issuerRefusal = /^BETTER_AUTH_URL is the OAuth issuer/u;

function composeAt(
  url: string,
  nodeEnv: "development" | "test" | "production" = "production",
  database: NonNullable<BetterAuthOptions["database"]> = {} as never,
) {
  return createAuthOptions({
    database,
    env: {
      NODE_ENV: nodeEnv,
      BETTER_AUTH_SECRET: "a".repeat(32),
      BETTER_AUTH_URL: url,
    },
    assertSignupAllowed: vi.fn(async () => ({})),
    resolveAgentGrantBindingFingerprints: async () => ({
      fingerprints: [],
      truncated: false,
    }),
    repairUnboundAgentConsent: async () => undefined,
  });
}

/**
 * The issuer's half of the shared origin rule (Plan 13, H.3; manifest-h.md
 * §2.8.1, Done when 4).
 *
 * `isServableIssuerUrl` decides which `BETTER_AUTH_URL` a composition may be
 * the OAuth issuer on, and `packages/client`'s `isBindableServer` which
 * server a checkout may be bound to. The two restate one rule, and this
 * suite and `packages/client/src/project.test.ts` hold each to the same
 * table, row by row, so neither can change alone without a failure.
 *
 * Asked through `createAuthOptions`, which is where production asks it:
 * `@requestport/auth/server` composes as it is imported, on Vercel, so a
 * refusal here is a refusal to serve.
 */
describe("which BETTER_AUTH_URL the composition takes as its issuer, by the shared origin rule", () => {
  test.each(
    originRule.cases.map((row) => [row.url, row.accepted, row.why] as const),
  )("answers %j with %s: %s", (url, accepted) => {
    if (accepted) {
      expect(() => composeAt(url)).not.toThrow();
    } else {
      expect(() => composeAt(url)).toThrow(issuerRefusal);
    }
  });

  /**
   * The rows this half exists for. A table that lost them would let the
   * issuer check accept a user name or a password again with every row still
   * passing, so their presence is asserted here and not left to the client's
   * suite.
   */
  test("holds production's issuer, accepted, and every user name and password row, refused", () => {
    const production = originRule.cases.filter(
      (row) => row.url === "https://requestport.com",
    );
    expect(production).toEqual([expect.objectContaining({ accepted: true })]);

    for (const kind of ["userinfo", "password-only", "username-only"]) {
      const rows = originRule.cases.filter((row) => row.kind === kind);
      const over = rows.map((row) => {
        const url = new URL(row.url);
        return `${url.protocol}//${url.hostname}`;
      });

      expect(
        rows.every((row) => !row.accepted),
        kind,
      ).toBe(true);
      expect(over, kind).toEqual(
        expect.arrayContaining(["https://requestport.com", "http://127.0.0.1"]),
      );
    }
  });

  test("does not repeat a refused URL's user name or password in its message", () => {
    expect(() =>
      composeAt("https://alice:sentinel-secret@requestport.com"),
    ).toThrow(
      expect.objectContaining({
        message: expect.stringMatching(issuerRefusal),
      }),
    );
    expect(() =>
      composeAt("https://alice:sentinel-secret@requestport.com"),
    ).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining("sentinel-secret"),
      }),
    );
  });

  /**
   * The table has no row with a path, because this is where the two halves
   * part by design: a binding names an origin and refuses a path
   * (`project.test.ts`), and the issuer check does not refuse one.
   */
  test("accepts a path, which only the binding refuses", () => {
    expect(() => composeAt("https://requestport.com/base")).not.toThrow();
  });
});

/**
 * Whether Better Auth's cookies are `Secure`, and so named `__Secure-…`
 * (Plan 13, H.3; ruling 108).
 *
 * K5 (`track-h.md`) measured WebKit keeping no `Secure` cookie over http
 * loopback, Better Auth's state cookie included, where Chromium and Firefox
 * keep them. `requestport start` is to serve a self-host on
 * `http://127.0.0.1:<port>` under `NODE_ENV=production` (manifest-h.md §2.3),
 * so a rule on `NODE_ENV` alone would leave a WebKit user there without
 * Better Auth's cookies (K5 infers that no sign-in needing one completes). In
 * a production runtime the cookies are `Secure` exactly when
 * `BETTER_AUTH_URL` is https, which leaves production's own composition as it
 * was; a development or test runtime keeps them plain over either scheme, as
 * before.
 */
describe("whether its cookies are Secure", () => {
  test.each([
    ["https://requestport.com", true],
    ["https://rp.example.com:8443", true],
    ["http://127.0.0.1:3000", false],
    ["http://localhost:3200", false],
    ["http://rp.localhost:3000", false],
    ["http://[::1]:3000", false],
  ])("in production at %s: %s", (url, secure) => {
    expect(composeAt(url).advanced.useSecureCookies).toBe(secure);
  });

  test.each(["development", "test"] as const)(
    "in %s, over neither scheme",
    (nodeEnv) => {
      for (const url of ["https://requestport.com", "http://localhost:3000"]) {
        expect(composeAt(url, nodeEnv).advanced.useSecureCookies, url).toBe(
          false,
        );
      }
    },
  );

  /**
   * The cookie a signed-in browser is handed, through Better Auth's own
   * handler, rather than the option that names it: the local credential, as
   * the operator command writes it, signs in under each production origin.
   */
  test.each([
    ["https://requestport.com", "__Secure-better-auth.session_token=", true],
    ["http://127.0.0.1:3000", "better-auth.session_token=", false],
  ])(
    "hands a browser signing in at %s the session cookie %s (Secure: %s)",
    async (url, name, secure) => {
      const credential = "a-local-credential-of-sufficient-length-0123";
      const auth = betterAuth(
        composeAt(
          url,
          "production",
          memoryAdapter({
            user: [
              {
                id: "user_owner",
                name: "owner",
                email: "owner@example.com",
                emailVerified: true,
                image: null,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ],
            session: [],
            account: [
              {
                id: "account_owner",
                accountId: "user_owner",
                providerId: "credential",
                userId: "user_owner",
                password: await hashLocalCredential(credential),
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ],
            verification: [],
            jwks: [],
            apikey: [],
            oauthClient: [],
            oauthRefreshToken: [],
            oauthAccessToken: [],
            oauthConsent: [],
            oauthResource: [],
            oauthClientResource: [],
            oauthClientAssertion: [],
          }),
        ),
      );

      const response = await auth.handler(
        new Request(new URL("/api/auth/sign-in/email", url), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: new URL(url).origin,
          },
          body: JSON.stringify({
            email: "owner@example.com",
            password: credential,
          }),
        }),
      );

      expect(response.status).toBe(200);
      const sessionCookie = response.headers
        .getSetCookie()
        .find((cookie) => cookie.includes("better-auth.session_token="));

      expect(sessionCookie?.startsWith(name)).toBe(true);
      expect(/;\s*Secure(?:;|$)/iu.test(sessionCookie ?? "")).toBe(secure);
    },
  );
});
