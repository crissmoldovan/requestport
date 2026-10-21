import { serverEnv } from "@requestport/config/server";
import { DomainError } from "@requestport/domain";
import { describe, expect, test } from "vitest";

import {
  bearerChallenge,
  reauthorizeWithResourceDescription,
  wantsResourceIndicator,
} from "./bearer-challenge.js";

const absolute = (path: string) =>
  new URL(path, serverEnv.BETTER_AUTH_URL).toString();

describe("the challenge every refused agent reads", () => {
  test("names the metadata document of the resource being refused", () => {
    // Each resource has its own, and handing a client another's would point it
    // at the wrong audience — which is the whole reason the path is a
    // parameter rather than a constant in here.
    expect(bearerChallenge("/.well-known/oauth-protected-resource/mcp")).toBe(
      `Bearer resource_metadata="${absolute("/.well-known/oauth-protected-resource/mcp")}"`,
    );
    expect(
      bearerChallenge("/.well-known/oauth-protected-resource/api/v1"),
    ).toContain(absolute("/.well-known/oauth-protected-resource/api/v1"));
    expect(
      bearerChallenge("/.well-known/oauth-protected-resource/api/v1"),
    ).not.toContain("/oauth-protected-resource/mcp");
  });

  test("says nothing beyond the scheme unless there is something to say", () => {
    const plain = bearerChallenge("/.well-known/oauth-protected-resource/mcp");

    expect(plain).not.toContain("error=");
    expect(plain).not.toContain("error_description=");
    expect(plain.startsWith("Bearer ")).toBe(true);
  });

  test("explains the one refusal an agent can act on", () => {
    const actionable = bearerChallenge(
      "/.well-known/oauth-protected-resource/mcp",
      { reauthorizeWithResource: true },
    );

    expect(actionable).toContain('error="invalid_token"');
    expect(actionable).toContain(
      `error_description="${reauthorizeWithResourceDescription}"`,
    );
    expect(actionable).toContain("resource_metadata=");
  });

  test("cannot let a value escape its own auth-param", () => {
    // The description is a constant for this reason. If it ever becomes
    // interpolated, a quote or a backslash would close the quoted-string early
    // and the rest would be read as further auth-params.
    expect(reauthorizeWithResourceDescription).not.toContain('"');
    expect(reauthorizeWithResourceDescription).not.toContain("\\");
    expect(reauthorizeWithResourceDescription).not.toMatch(/[\r\n]/u);

    const actionable = bearerChallenge(
      "/.well-known/oauth-protected-resource/mcp",
      { reauthorizeWithResource: true },
    );
    // Three quoted values, six quotes, and nothing loose between them.
    expect(actionable.match(/"/gu)).toHaveLength(6);
    expect(actionable).not.toMatch(/[\r\n]/u);
  });

  test("recognises only the flag the bearer path actually sets", () => {
    expect(
      wantsResourceIndicator(
        new DomainError("unauthenticated", "no", {
          reauthorizeWithResource: true,
        }),
      ),
    ).toBe(true);
    // Not a truthy value, and not a neighbouring detail: an agent must not be
    // told to re-authorize because some unrelated detail happened to be set.
    for (const details of [
      {},
      { reauthorizeWithResource: false },
      { reauthorizeWithResource: "true" },
      { reauthorizeWithResource: 1 },
      { field: "slug" },
    ]) {
      expect(
        wantsResourceIndicator(
          new DomainError("unauthenticated", "no", details),
        ),
      ).toBe(false);
    }
  });
});
