import type {
  FoundationQueryRepository,
  OrganizationAccess,
} from "@requestport/domain";
import { describe, expect, test, vi } from "vitest";

import { resolveCurrentOrganization } from "./current-organization.js";

const FIRST_ORGANIZATION: OrganizationAccess = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Alpha",
  slug: "alpha",
  role: "owner",
};
const SECOND_ORGANIZATION: OrganizationAccess = {
  id: "00000000-0000-4000-8000-000000000002",
  name: "Beta",
  slug: "beta",
  role: "admin",
};

function queryRepository({
  preferred = null,
  organizations = [FIRST_ORGANIZATION, SECOND_ORGANIZATION],
}: {
  preferred?: OrganizationAccess | null;
  organizations?: OrganizationAccess[];
} = {}) {
  return {
    findActiveOrganizationForUser: vi.fn(async () => preferred),
    listActiveOrganizationsForUser: vi.fn(async () => organizations),
    listOrganizationMembers: vi.fn(),
    listOrganizationLanes: vi.fn(),
    listOrganizationProjects: vi.fn(),
    listPendingInvitations: vi.fn(),
  } satisfies FoundationQueryRepository;
}

describe("resolveCurrentOrganization", () => {
  test("uses a preferred organization only when the active-list snapshot contains it", async () => {
    const query = queryRepository();

    await expect(
      resolveCurrentOrganization({
        preferredOrganizationId: SECOND_ORGANIZATION.id,
        query,
        userId: "user_1",
      }),
    ).resolves.toEqual({
      currentOrganization: SECOND_ORGANIZATION,
      organizations: [FIRST_ORGANIZATION, SECOND_ORGANIZATION],
    });
    expect(query.findActiveOrganizationForUser).not.toHaveBeenCalled();
  });

  test("ignores a race-shaped preferred lookup that disagrees with the active-list snapshot", async () => {
    const query = queryRepository({
      preferred: SECOND_ORGANIZATION,
      organizations: [FIRST_ORGANIZATION],
    });

    await expect(
      resolveCurrentOrganization({
        preferredOrganizationId: SECOND_ORGANIZATION.id,
        query,
        userId: "user_1",
      }),
    ).resolves.toEqual({
      currentOrganization: FIRST_ORGANIZATION,
      organizations: [FIRST_ORGANIZATION],
    });
    expect(query.findActiveOrganizationForUser).not.toHaveBeenCalled();
  });

  test.each([
    ["malformed", "not-a-uuid"],
    ["unjoined", "00000000-0000-4000-8000-000000000099"],
    ["revoked", "00000000-0000-4000-8000-000000000098"],
    ["inactive", "00000000-0000-4000-8000-000000000097"],
  ])(
    "falls back deterministically without trusting a %s preference",
    async (_reason, preferredOrganizationId) => {
      const query = queryRepository();

      await expect(
        resolveCurrentOrganization({
          preferredOrganizationId,
          query,
          userId: "user_1",
        }),
      ).resolves.toEqual({
        currentOrganization: FIRST_ORGANIZATION,
        organizations: [FIRST_ORGANIZATION, SECOND_ORGANIZATION],
      });
      expect(query.findActiveOrganizationForUser).not.toHaveBeenCalled();
    },
  );

  test("keeps an authenticated user with no membership in a setup state", async () => {
    const query = queryRepository({ organizations: [] });

    await expect(
      resolveCurrentOrganization({
        preferredOrganizationId: undefined,
        query,
        userId: "user_without_membership",
      }),
    ).resolves.toEqual({ currentOrganization: null, organizations: [] });
  });
});
