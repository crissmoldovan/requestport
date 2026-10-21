import { serverEnv } from "@requestport/config/server";
import { DomainError } from "@requestport/domain";
import { describe, expect, test } from "vitest";

import { RequestTooLargeError } from "../../lib/security/input-limits.js";
import { unauthorized } from "./unauthorized.js";

/**
 * The refusal an agent actually receives, which nothing was reading.
 *
 * This decides a status, a message and a `WWW-Authenticate` challenge, and it
 * lived inside `route.ts` where a Next route module exports only its handlers
 * — so it was reachable from no test, and a dropped comma between auth-params
 * or a quote loose in the quoted-string would have shipped silently.
 */
async function refusal(error: unknown) {
  const response = unauthorized(error);

  return {
    status: response.status,
    challenge: response.headers.get("www-authenticate") ?? "",
    cacheControl: response.headers.get("cache-control"),
    retryAfter: response.headers.get("retry-after"),
    body: (await response.json()) as { error: string; message: string },
  };
}

describe("what an MCP request is told when it is refused", () => {
  test("maps each refusal to the status that describes it", async () => {
    const cases = [
      ["unauthenticated", 401],
      ["rate_limited", 429],
      ["validation_failed", 400],
      ["configuration_error", 503],
      ["forbidden", 403],
    ] as const;

    for (const [code, status] of cases) {
      expect((await refusal(new DomainError(code, "why"))).status).toBe(status);
    }
    // Anything that is not ours is not given a code of ours either.
    const unknown = await refusal(new Error("boom"));
    expect(unknown.status).toBe(403);
    expect(unknown.body.error).toBe("unexpected_error");
  });

  test("never repeats the thrown message back to the caller", async () => {
    // A DomainError's message is written for an operator reading a log, not
    // for whoever presented the credential.
    const { body } = await refusal(
      new DomainError("unauthenticated", "grant 7f2 revoked for user u_12"),
    );

    expect(body.message).not.toContain("7f2");
    expect(body.message).not.toContain("u_12");
    expect(body.message).toBe("A valid agent credential is required.");
  });

  test("carries the resource metadata on every challenge", async () => {
    // Built from the configured origin rather than asserted against a literal,
    // because the origin differs per environment and the contract here is the
    // document's address, not the host it happens to sit on.
    const expected = new URL(
      "/.well-known/oauth-protected-resource/mcp",
      serverEnv.BETTER_AUTH_URL,
    ).toString();

    for (const error of [
      new DomainError("unauthenticated", "no"),
      new DomainError("forbidden", "no"),
      new Error("boom"),
    ]) {
      const { challenge } = await refusal(error);

      expect(challenge).toContain(`resource_metadata="${expected}"`);
      // Absolute, because a client resolves it without a base.
      expect(expected.startsWith("http")).toBe(true);
    }
  });

  test("tells a token it cannot read what to do about it", async () => {
    // The opaque-access-token case: a refresh that omitted the resource
    // indicator gets a token this resource cannot verify, and the bearer path
    // marks the refusal so this can say so rather than answering exactly as it
    // answers a forgery.
    const plain = await refusal(new DomainError("unauthenticated", "no"));
    const actionable = await refusal(
      new DomainError("unauthenticated", "no", {
        reauthorizeWithResource: true,
      }),
    );

    expect(plain.challenge).not.toContain("error=");
    expect(actionable.challenge).toContain('error="invalid_token"');
    expect(actionable.challenge).toContain("error_description=");
    expect(actionable.body.message).toContain("resource indicator");
    expect(actionable.body.message).not.toBe(plain.body.message);
    expect(actionable.status).toBe(401);
  });

  test("puts nothing in the challenge that could end a header", async () => {
    // The description is a literal in the module for this reason: a quote or a
    // backslash reaching the quoted-string would let a value escape its own
    // auth-param. Asserted rather than assumed, because the literal is the
    // whole defence.
    const { challenge } = await refusal(
      new DomainError("unauthenticated", 'a " and a \\ and a \n', {
        reauthorizeWithResource: true,
      }),
    );
    const description = challenge
      .split('error_description="')[1]
      ?.split('"')[0];

    expect(description).toBeDefined();
    expect(description).not.toContain("\\");
    expect(challenge).not.toContain("\n");
    // Exactly the auth-params this sends, in the order it sends them.
    expect(challenge.startsWith("Bearer ")).toBe(true);
    expect(challenge.match(/resource_metadata=/gu)).toHaveLength(1);
  });

  test("says how long to wait only when it knows", async () => {
    const withHint = await refusal(
      new DomainError("rate_limited", "slow down", { retryAfterSeconds: 30 }),
    );
    const withoutHint = await refusal(new DomainError("rate_limited", "slow"));

    expect(withHint.retryAfter).toBe("30");
    expect(withoutHint.retryAfter).toBeNull();
  });

  test("refuses a body too large before it looks at anything else", async () => {
    const { status, body, cacheControl } = await refusal(
      new RequestTooLargeError(),
    );

    expect(status).toBe(413);
    expect(body.error).toBe("request_too_large");
    expect(cacheControl).toBe("no-store");
  });

  test("is never cached", async () => {
    for (const error of [
      new DomainError("unauthenticated", "no"),
      new DomainError("rate_limited", "no"),
      new Error("boom"),
    ]) {
      expect((await refusal(error)).cacheControl).toBe("no-store");
    }
  });
});
