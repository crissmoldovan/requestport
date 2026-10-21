import { DomainError } from "@requestport/domain";
import { describe, expect, test } from "vitest";

import {
  bearerChallenge,
  reauthorizeWithResourceDescription,
  wantsResourceIndicator,
} from "./bearer-challenge.js";

const publicUrl = "https://requestport.test";

describe("bearerChallenge, against the public URL it is given", () => {
  test("names the resource's own metadata document, absolute against the public URL", () => {
    expect(
      bearerChallenge(publicUrl, "/.well-known/oauth-protected-resource/mcp"),
    ).toBe(
      'Bearer resource_metadata="https://requestport.test/.well-known/oauth-protected-resource/mcp"',
    );
    expect(
      bearerChallenge(
        "http://127.0.0.1:4321",
        "/.well-known/oauth-protected-resource/api/v1",
      ),
    ).toBe(
      'Bearer resource_metadata="http://127.0.0.1:4321/.well-known/oauth-protected-resource/api/v1"',
    );
  });

  test("resolves the document's path as a URL does, so a public URL's own path does not prefix it", () => {
    expect(
      bearerChallenge(
        "https://requestport.test/ignored/",
        "/.well-known/oauth-protected-resource/mcp",
      ),
    ).toBe(
      'Bearer resource_metadata="https://requestport.test/.well-known/oauth-protected-resource/mcp"',
    );
  });

  test("explains the one refusal an agent can act on", () => {
    expect(
      bearerChallenge(publicUrl, "/.well-known/oauth-protected-resource/mcp", {
        reauthorizeWithResource: true,
      }),
    ).toBe(
      `Bearer error="invalid_token", error_description="${reauthorizeWithResourceDescription}", resource_metadata="https://requestport.test/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  test("the description is a constant no quoted-string can be escaped from", () => {
    expect(reauthorizeWithResourceDescription).not.toMatch(/["\\\r\n]/u);
  });
});

describe("wantsResourceIndicator", () => {
  test("is true only for a refusal that says so", () => {
    expect(
      wantsResourceIndicator(
        new DomainError("unauthenticated", "no", {
          reauthorizeWithResource: true,
        }),
      ),
    ).toBe(true);
    expect(
      wantsResourceIndicator(
        new DomainError("unauthenticated", "no", {
          reauthorizeWithResource: "yes",
        }),
      ),
    ).toBe(false);
    expect(
      wantsResourceIndicator(new DomainError("unauthenticated", "no")),
    ).toBe(false);
  });
});
