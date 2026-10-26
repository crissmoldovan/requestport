import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { ConsoleToasts } from "../../../../components/console-toasts.js";

const organization = {
  id: "00000000-0000-4000-8000-0000000000d1",
  name: "CUE++",
  slug: "example-org",
};

const members = vi.hoisted(() => ({
  invitations: vi.fn(),
  members: vi.fn(),
  organization: {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  } as { id: string; name: string; role: string; slug: string } | null,
}));

vi.mock("@requestport/db", () => ({
  createFoundationQueryRepository: () => ({
    listOrganizationMembers: members.members,
    listPendingInvitations: members.invitations,
  }),
}));

vi.mock("../../../../lib/server-request-port.js", () => ({
  webStorage: () => ({ db: {} }),
}));

vi.mock("../../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization: members.organization,
    session: { user: { id: "00000000-0000-4000-8000-0000000000aa" } },
  }),
}));

vi.mock("../../actions.js", () => ({
  inviteMemberAction: async () => ({ status: "idle" }),
}));

vi.mock("./actions.js", () => {
  const inert = async () => ({ message: "", status: "idle" });
  return {
    resendInvitationAction: inert,
    revokeInvitationAction: inert,
    setOrganizationMemberAction: inert,
  };
});

const { default: MembersSettingsPage } = await import("./page.js");

const owner = {
  email: "owner@example.com",
  joinedAt: new Date("2026-03-04T10:00:00.000Z"),
  name: "Owner",
  role: "owner" as const,
  userId: "00000000-0000-4000-8000-0000000000aa",
  version: 1,
};

const invitation = {
  email: "pending@example.com",
  expiresAt: new Date("2026-08-23T12:00:00.000Z"),
  id: "00000000-0000-4000-8000-0000000000e1",
  role: "member" as const,
  version: 1,
};

async function render() {
  return renderToStaticMarkup(
    <ConsoleToasts>{await MembersSettingsPage()}</ConsoleToasts>,
  );
}

/** The pending invitations section, where Resend and Revoke are drawn. */
function pendingSection(markup: string) {
  return markup.slice(markup.indexOf('id="pending-invitations"'));
}

beforeEach(() => {
  members.members.mockReset().mockResolvedValue([owner]);
  members.invitations.mockReset().mockResolvedValue([invitation]);
});

describe("the members page's invitation actions (ruling 260)", () => {
  test("hands an owner Resend beside Revoke, each form with a key of its own", async () => {
    members.organization = { ...organization, role: "owner" };
    const pending = pendingSection(await render());

    expect(members.invitations).toHaveBeenCalledOnce();
    expect(pending).toContain("pending@example.com");
    expect(pending).toContain("Resend invitation");
    expect(pending).toContain("Revoke invitation");
    // The page mints one key per form, so the two forms of one row never
    // share a receipt.
    const keys = [
      ...pending.matchAll(/name="idempotencyKey" value="([^"]+)"/gu),
    ].map((match) => match[1]);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  test("reads no invitations for a member, so offers neither action", async () => {
    members.organization = { ...organization, role: "member" };
    const markup = await render();

    expect(members.invitations).not.toHaveBeenCalled();
    expect(markup).not.toContain("Resend invitation");
    expect(markup).not.toContain("Revoke invitation");
    expect(markup).not.toContain("pending@example.com");
  });
});
