import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import {
  appearanceFormContextDomain,
  appearanceFormContextTtlSeconds,
  createAppearanceFormContext,
  verifyAppearanceFormContext,
} from "./appearance-form-context.js";

/** Long enough to satisfy the same minimum the command fingerprint enforces. */
const secret = "requestport-test-secret-0123456789abcdef";
const actorId = "user_01HZY0000000000000000000";
const organizationId = "00000000-0000-4000-8000-000000000001";
const issuedAt = Date.UTC(2026, 7, 18, 12, 0, 0);

function personalToken(overrides: { issuedAt?: number } = {}) {
  return createAppearanceFormContext({
    claims: { actorId, organizationId: null },
    issuedAt: overrides.issuedAt ?? issuedAt,
    secret,
  });
}

function organizationToken(overrides: { issuedAt?: number } = {}) {
  return createAppearanceFormContext({
    claims: { actorId, organizationId },
    issuedAt: overrides.issuedAt ?? issuedAt,
    secret,
  });
}

function segments(token: string) {
  const parts = token.split(".");
  return {
    mac: parts[2] ?? "",
    payload: parts[1] ?? "",
    version: parts[0] ?? "",
  };
}

function decodePayload(token: string): unknown {
  return JSON.parse(
    Buffer.from(segments(token).payload, "base64url").toString("utf8"),
  );
}

function reseal(payload: unknown, mac: string) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `v1.${encoded}.${mac}`;
}

describe("appearance render-context token payload", () => {
  test("carries only the actor, tenant, and issue time", () => {
    const token = organizationToken();
    const payload = decodePayload(token) as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual(["a", "o", "t"]);
    expect(payload.a).toBe(actorId);
    expect(payload.o).toBe(organizationId);
    expect(payload.t).toBe(Math.floor(issuedAt / 1000));
  });

  test("carries a null tenant for a personal form", () => {
    const payload = decodePayload(personalToken()) as Record<string, unknown>;

    expect(payload.o).toBeNull();
  });

  test("never carries a session or credential identifier", () => {
    const token = createAppearanceFormContext({
      claims: { actorId, organizationId },
      issuedAt,
      secret,
    });

    expect(token).not.toContain("session");
    expect(JSON.stringify(decodePayload(token))).not.toContain("session");
  });

  test("refuses to seal a token with a weak secret", () => {
    expect(() =>
      createAppearanceFormContext({
        claims: { actorId, organizationId: null },
        secret: "too-short",
      }),
    ).toThrow();
  });
});

describe("appearance render-context verification", () => {
  test("accepts a fresh personal token for the same actor", () => {
    expect(
      verifyAppearanceFormContext({
        expected: { actorId, organizationId: null },
        now: issuedAt + 1000,
        secret,
        token: personalToken(),
      }),
    ).toBe(true);
  });

  test("accepts a fresh organization token for the same actor and tenant", () => {
    expect(
      verifyAppearanceFormContext({
        expected: { actorId, organizationId },
        now: issuedAt + 1000,
        secret,
        token: organizationToken(),
      }),
    ).toBe(true);
  });

  test("keeps a personal token valid across an organization switch", () => {
    // Personal preferences are global, so the token binds the actor only; the
    // freshly resolved organization is irrelevant to the comparison.
    expect(
      verifyAppearanceFormContext({
        expected: { actorId, organizationId: null },
        now: issuedAt + appearanceFormContextTtlSeconds * 1000 - 1,
        secret,
        token: personalToken(),
      }),
    ).toBe(true);
  });

  test("rejects an edited payload", () => {
    const token = organizationToken();
    const payload = decodePayload(token) as Record<string, unknown>;

    expect(
      verifyAppearanceFormContext({
        expected: { actorId: "user_other", organizationId },
        now: issuedAt + 1000,
        secret,
        token: reseal({ ...payload, a: "user_other" }, segments(token).mac),
      }),
    ).toBe(false);
  });

  test("rejects an edited signature", () => {
    const token = organizationToken();
    const { mac, payload } = segments(token);
    const flipped = `${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`;

    expect(
      verifyAppearanceFormContext({
        expected: { actorId, organizationId },
        now: issuedAt + 1000,
        secret,
        token: `v1.${payload}.${flipped}`,
      }),
    ).toBe(false);
  });

  test("rejects an unknown token version", () => {
    const { mac, payload } = segments(organizationToken());

    expect(
      verifyAppearanceFormContext({
        expected: { actorId, organizationId },
        now: issuedAt + 1000,
        secret,
        token: `v2.${payload}.${mac}`,
      }),
    ).toBe(false);
  });

  test("rejects malformed, absent, and oversized tokens", () => {
    for (const token of [
      "",
      "   ",
      "v1.only-two",
      "v1..",
      "not-a-token",
      null,
      undefined,
      42,
      { token: "v1.a.b" },
      `v1.${"a".repeat(4096)}.b`,
    ]) {
      expect(
        verifyAppearanceFormContext({
          expected: { actorId, organizationId },
          now: issuedAt + 1000,
          secret,
          token,
        }),
      ).toBe(false);
    }
  });

  test("accepts at the time-to-live boundary and rejects past it", () => {
    const token = personalToken();
    const expected = { actorId, organizationId: null };

    expect(
      verifyAppearanceFormContext({
        expected,
        now: issuedAt + appearanceFormContextTtlSeconds * 1000,
        secret,
        token,
      }),
    ).toBe(true);
    expect(
      verifyAppearanceFormContext({
        expected,
        now: issuedAt + appearanceFormContextTtlSeconds * 1000 + 1000,
        secret,
        token,
      }),
    ).toBe(false);
  });

  test("rejects a token issued beyond the tolerated clock skew", () => {
    expect(
      verifyAppearanceFormContext({
        expected: { actorId, organizationId: null },
        now: issuedAt - 120_000,
        secret,
        token: personalToken(),
      }),
    ).toBe(false);
  });

  test("rejects the form after an account switch", () => {
    expect(
      verifyAppearanceFormContext({
        expected: { actorId: "user_second", organizationId: null },
        now: issuedAt + 1000,
        secret,
        token: personalToken(),
      }),
    ).toBe(false);
  });

  test("rejects the form after an organization switch", () => {
    expect(
      verifyAppearanceFormContext({
        expected: {
          actorId,
          organizationId: "00000000-0000-4000-8000-000000000002",
        },
        now: issuedAt + 1000,
        secret,
        token: organizationToken(),
      }),
    ).toBe(false);
  });

  test("never lets a personal token stand in for an organization write", () => {
    expect(
      verifyAppearanceFormContext({
        expected: { actorId, organizationId },
        now: issuedAt + 1000,
        secret,
        token: personalToken(),
      }),
    ).toBe(false);
    expect(
      verifyAppearanceFormContext({
        expected: { actorId, organizationId: null },
        now: issuedAt + 1000,
        secret,
        token: organizationToken(),
      }),
    ).toBe(false);
  });

  test("rejects a token sealed with the raw secret rather than the domain key", () => {
    const { payload } = segments(personalToken());
    const undomained = createHmac("sha256", secret)
      .update(payload)
      .digest("base64url");

    expect(appearanceFormContextDomain).toBe("appearance-form-context-v1");
    expect(
      verifyAppearanceFormContext({
        expected: { actorId, organizationId: null },
        now: issuedAt + 1000,
        secret,
        token: `v1.${payload}.${undomained}`,
      }),
    ).toBe(false);
  });

  test("rejects a token sealed with another secret", () => {
    expect(
      verifyAppearanceFormContext({
        expected: { actorId, organizationId: null },
        now: issuedAt + 1000,
        secret: `${secret}-rotated`,
        token: personalToken(),
      }),
    ).toBe(false);
  });

  test("compares the signature in constant time", async () => {
    const module = await readFile(
      new URL("./appearance-form-context.ts", import.meta.url),
      "utf8",
    );

    expect(module).toContain("timingSafeEqual");
  });
});
