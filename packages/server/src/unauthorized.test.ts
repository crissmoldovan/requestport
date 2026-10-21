import { DomainError } from "@requestport/domain";
import { describe, expect, test, vi } from "vitest";

import { reauthorizeWithResourceDescription } from "./bearer-challenge.js";
import { RequestTooLargeError } from "./input-limits.js";
import { unauthorized } from "./unauthorized.js";

/*
  The MCP refusal, with the challenge handed to it. The web's
  `apps/web/src/app/mcp/unauthorized.test.ts`, unchanged, holds the statuses,
  the messages and the challenge's form over `BETTER_AUTH_URL`; this holds
  what the move added: the challenge is the caller's, asked for MCP's
  protected-resource document.
*/

function challengeOver() {
  return vi.fn(
    (path: string, options: { reauthorizeWithResource?: boolean }) =>
      `Bearer at ${path}${options.reauthorizeWithResource ? ", again" : ""}`,
  );
}

describe("the MCP refusal", () => {
  test.each([
    ["unauthenticated", 401, "A valid agent credential is required."],
    ["rate_limited", 429, "Too many requests. Retry later."],
    ["validation_failed", 400, "The MCP request is invalid."],
    ["configuration_error", 503, "RequestPort is temporarily unavailable."],
    [
      "forbidden",
      403,
      "The credential is not permitted to access this resource.",
    ],
  ] as const)(
    "%s: %i, its message, and the caller's challenge for MCP's document",
    async (code, status, message) => {
      const challenge = challengeOver();

      const response = unauthorized(new DomainError(code, "why"), challenge);

      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("www-authenticate")).toBe(
        "Bearer at /.well-known/oauth-protected-resource/mcp",
      );
      expect(challenge).toHaveBeenCalledExactlyOnceWith(
        "/.well-known/oauth-protected-resource/mcp",
        { reauthorizeWithResource: false },
      );
      expect(await response.json()).toEqual({ error: code, message });
    },
  );

  test("an opaque token: asks the challenge to name the resource indicator, and explains it", async () => {
    const challenge = challengeOver();

    const response = unauthorized(
      new DomainError("unauthenticated", "opaque", {
        reauthorizeWithResource: true,
      }),
      challenge,
    );

    expect(response.headers.get("www-authenticate")).toBe(
      "Bearer at /.well-known/oauth-protected-resource/mcp, again",
    );
    expect((await response.json()).message).toBe(
      reauthorizeWithResourceDescription,
    );
  });

  test("a rate limit: retry-after from the refusal's details", () => {
    const response = unauthorized(
      new DomainError("rate_limited", "Too many requests", {
        retryAfterSeconds: 11,
      }),
      challengeOver(),
    );

    expect(response.headers.get("retry-after")).toBe("11");
  });

  test("an error not of ours: 403 unexpected_error, with the challenge", async () => {
    const response = unauthorized(new Error("boom"), challengeOver());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "unexpected_error",
      message: "RequestPort authorization failed.",
    });
    expect(response.headers.get("www-authenticate")).not.toBeNull();
  });

  test("a body past its bound: 413, with no challenge", async () => {
    const challenge = challengeOver();

    const response = unauthorized(new RequestTooLargeError(), challenge);

    expect(response.status).toBe(413);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(challenge).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      error: "request_too_large",
      message: "MCP request body is too large",
    });
  });
});
