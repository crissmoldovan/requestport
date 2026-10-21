import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const page = vi.hoisted(() => ({
  availability: vi.fn(),
  list: vi.fn(),
  organization: {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  } as { id: string; name: string; role: string; slug: string } | null,
  projects: vi.fn(),
  userId: "00000000-0000-4000-8000-0000000000aa",
}));

vi.mock("@requestport/auth/server", () => ({
  operatorCredentialAvailability: page.availability,
  operatorCredentialService: { list: page.list },
}));

vi.mock("@requestport/db", () => ({
  createFoundationQueryRepository: () => ({
    listOrganizationProjects: page.projects,
  }),
}));

// The web root, whose storage the page builds its repository over when it
// runs (Plan 13, G.3).
vi.mock("../../../../lib/server-request-port.js", () => ({
  webStorage: () => ({ db: {} }),
}));

vi.mock("../../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization: page.organization,
    session: { session: { id: "session_live" }, user: { id: page.userId } },
  }),
}));

vi.mock("../../../../lib/server-core-commands.js", () => ({
  humanCommandContext: (
    session: { session: { id: string }; user: { id: string } },
    organizationId: string,
  ) => ({
    actor: { type: "user", id: session.user.id },
    organizationId,
    scopes: new Set(["operator:manage"]),
    credentialId: session.session.id,
    correlationId: "correlation",
  }),
}));

vi.mock("../../../../components/administration-views.js", () => ({
  NoOrganizationSetup: () => <p>Create your first organization</p>,
}));

vi.mock("./actions.js", () => {
  const inert = async () => ({ message: "", status: "idle" });
  return {
    issueOperatorCredentialAction: inert,
    revokeOperatorCredentialAction: inert,
    rotateOperatorCredentialAction: inert,
  };
});

import OperatorCredentialsPage from "./page.js";

/*
  Plan 13, F.3: `/settings/operators`, reachable by its URL only until F.3.1
  adds the navigation entry. While F3-14's answer is off it draws the
  unavailable state and reads nothing else — before the migration there is no
  table to read. Once on, it lists the organisation's credentials (a person
  who is not an owner or admin sees only their own), offers rotation to each
  credential's issuer only, and draws the issuance form.
*/

const credential = (overrides: Record<string, unknown> = {}) => ({
  id: "00000000-0000-4000-8000-0000000000c1",
  organizationId: "00000000-0000-4000-8000-0000000000d1",
  memberUserId: page.userId,
  projectId: null,
  betterAuthApiKeyId: "apikey_1",
  lineageId: "00000000-0000-4000-8000-0000000000c1",
  rotatedFromId: null,
  name: "Nightly deploy",
  prefix: "rpo_abcd",
  fingerprint: "fingerprint",
  scopes: ["operator:revoke"],
  version: 1,
  expiresAt: new Date("2026-10-29T00:00:00.000Z"),
  revokedAt: null,
  overlapExpiresAt: null,
  lastUsedAt: null,
  createdAt: new Date("2026-09-29T00:00:00.000Z"),
  ...overrides,
});

async function markup() {
  return renderToStaticMarkup(
    (await OperatorCredentialsPage()) as ReactElement,
  );
}

beforeEach(() => {
  page.availability.mockReset();
  page.list.mockReset();
  page.projects.mockReset();
  page.projects.mockResolvedValue([]);
  page.organization = {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  };
});

describe("the operator credentials page", () => {
  test.each([
    ["not-migrated", "migration"],
    ["switched-off", "switched off"],
    ["change-password-mounted", "/change-password"],
  ] as const)(
    "draws the unavailable state (%s) and reads nothing else",
    async (reason, says) => {
      page.availability.mockResolvedValue({ available: false, reason });
      const html = await markup();
      expect(html).toContain("Operator credentials");
      expect(html).toContain(says);
      expect(html).not.toContain("Issue one-time key");
      expect(page.list).not.toHaveBeenCalled();
      expect(page.projects).not.toHaveBeenCalled();
    },
  );

  test("lists the organisation's credentials and draws the issuance form once available", async () => {
    page.availability.mockResolvedValue({ available: true });
    page.list.mockResolvedValue([
      credential(),
      credential({
        id: "00000000-0000-4000-8000-0000000000c2",
        memberUserId: "someone-else",
        name: "Someone else's import",
      }),
      credential({
        id: "00000000-0000-4000-8000-0000000000c3",
        name: "Retired",
        revokedAt: new Date("2026-09-30T00:00:00.000Z"),
      }),
    ]);
    const html = await markup();
    expect(page.list).toHaveBeenCalledWith(
      expect.objectContaining({ credentialId: "session_live" }),
      "00000000-0000-4000-8000-0000000000d1",
    );
    expect(html).toContain("Nightly deploy");
    expect(html).toContain("Someone else&#x27;s import");
    expect(html).toContain("Retired");
    expect(html).toContain("rpo_abcd");
    expect(html).toContain("Issue one-time key");
    // Rotation for the issuer's own live credential only; revocation for
    // both live ones; nothing for the revoked one.
    expect(html.match(/Rotate key/gu)).toHaveLength(1);
    expect(html.match(/>Revoke key</gu)).toHaveLength(2);
  });

  test("shows a person who is not an owner or admin only their own credentials", async () => {
    page.organization = {
      id: "00000000-0000-4000-8000-0000000000d1",
      name: "CUE++",
      role: "member",
      slug: "example-org",
    };
    page.availability.mockResolvedValue({ available: true });
    page.list.mockResolvedValue([
      credential(),
      credential({
        id: "00000000-0000-4000-8000-0000000000c2",
        memberUserId: "someone-else",
        name: "Someone else's import",
      }),
    ]);
    const html = await markup();
    expect(html).toContain("Nightly deploy");
    expect(html).not.toContain("Someone else");
  });

  test("an empty list says so", async () => {
    page.availability.mockResolvedValue({ available: true });
    page.list.mockResolvedValue([]);
    expect(await markup()).toContain("No operator credentials");
  });

  test("a person with no organisation is sent to set one up", async () => {
    page.organization = null;
    expect(await markup()).toContain("Create your first organization");
    expect(page.availability).not.toHaveBeenCalled();
  });
});
