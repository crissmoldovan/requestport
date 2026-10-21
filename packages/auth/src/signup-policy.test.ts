import { describe, expect, test } from "vitest";

import {
  createSignupPolicy,
  SignupPolicyDeniedError,
  type SignupPolicyRepository,
} from "./signup-policy.js";

const now = new Date("2026-08-16T12:00:00.000Z");

function repository(
  overrides: Partial<SignupPolicyRepository> = {},
): SignupPolicyRepository {
  return {
    findExistingUser: async () => null,
    findInvitations: async () => [],
    findAllowlistEntries: async () => [],
    ...overrides,
  };
}

describe("restricted signup policy", () => {
  test("allows an existing Better Auth user after normalizing the email", async () => {
    const lookedUp: string[] = [];
    const policy = createSignupPolicy({
      now: () => now,
      repository: repository({
        findExistingUser: async (email) => {
          lookedUp.push(email);
          return { id: "user_1" };
        },
      }),
    });

    await expect(
      policy.assertSignupAllowed("  INVITÉ@Example.COM  "),
    ).resolves.toEqual({
      allowed: true,
      reason: "existing_user",
    });
    expect(lookedUp).toEqual(["invité@example.com"]);
  });

  test("allows an active invitation", async () => {
    const policy = createSignupPolicy({
      now: () => now,
      repository: repository({
        findInvitations: async () => [
          {
            id: "invite_1",
            acceptedAt: null,
            revokedAt: null,
            expiresAt: new Date("2026-08-17T12:00:00.000Z"),
          },
        ],
      }),
    });

    await expect(
      policy.assertSignupAllowed("person@example.com"),
    ).resolves.toEqual({
      allowed: true,
      reason: "invitation",
      invitationId: "invite_1",
    });
  });

  test("allows an active allowlist entry", async () => {
    const policy = createSignupPolicy({
      now: () => now,
      repository: repository({
        findAllowlistEntries: async () => [
          {
            status: "active",
            expiresAt: new Date("2026-08-17T12:00:00.000Z"),
          },
        ],
      }),
    });

    await expect(
      policy.assertSignupAllowed("person@example.com"),
    ).resolves.toEqual({
      allowed: true,
      reason: "allowlist",
    });
  });

  test.each([
    {
      name: "expired invitation",
      expectedReason: "expired" as const,
      invitations: [
        {
          id: "invite_old",
          acceptedAt: null,
          revokedAt: null,
          expiresAt: new Date("2026-08-15T12:00:00.000Z"),
        },
      ],
      allowlist: [],
    },
    {
      name: "revoked invitation",
      expectedReason: "revoked" as const,
      invitations: [
        {
          id: "invite_revoked",
          acceptedAt: null,
          revokedAt: new Date("2026-08-15T12:00:00.000Z"),
          expiresAt: new Date("2026-08-17T12:00:00.000Z"),
        },
      ],
      allowlist: [],
    },
    {
      name: "expired allowlist entry",
      expectedReason: "expired" as const,
      invitations: [],
      allowlist: [
        {
          status: "active",
          expiresAt: new Date("2026-08-15T12:00:00.000Z"),
        },
      ],
    },
    {
      name: "revoked allowlist entry",
      expectedReason: "revoked" as const,
      invitations: [],
      allowlist: [{ status: "revoked", expiresAt: null }],
    },
  ])("denies an otherwise ineligible $name", async (fixture) => {
    const policy = createSignupPolicy({
      now: () => now,
      repository: repository({
        findInvitations: async () => fixture.invitations,
        findAllowlistEntries: async () => fixture.allowlist,
      }),
    });

    const result = policy.assertSignupAllowed("person@example.com");
    await expect(result).rejects.toBeInstanceOf(SignupPolicyDeniedError);
    await expect(result).rejects.toMatchObject({
      reason: fixture.expectedReason,
    });
  });

  test("denies an unknown email without eligibility details", async () => {
    const policy = createSignupPolicy({
      now: () => now,
      repository: repository(),
    });

    await expect(
      policy.assertSignupAllowed("unknown@example.com"),
    ).rejects.toMatchObject({
      reason: "signup_disabled",
    });
  });

  test("an active path wins over stale and revoked records", async () => {
    const policy = createSignupPolicy({
      now: () => now,
      repository: repository({
        findInvitations: async () => [
          {
            id: "invite_revoked",
            acceptedAt: null,
            revokedAt: new Date("2026-08-15T12:00:00.000Z"),
            expiresAt: new Date("2026-08-17T12:00:00.000Z"),
          },
        ],
        findAllowlistEntries: async () => [
          { status: "active", expiresAt: null },
        ],
      }),
    });

    await expect(
      policy.assertSignupAllowed("person@example.com"),
    ).resolves.toEqual({
      allowed: true,
      reason: "allowlist",
    });
  });
});
