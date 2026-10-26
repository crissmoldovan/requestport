/**
 * F.2.7 — members, invitations and organisation appearance. Each action runs
 * its command on the tenant bus, and `/api/v1` reaches the same command for
 * an operator credential through its registry entry
 * (`credentialKinds: ["operator"]`, ruling 25): `invite_organization_member`,
 * `appearance.update_organization_defaults.v1`, `set_organization_member`,
 * `revoke_organization_invitation`, and `resend_organization_invitation`,
 * which `resendInvitationAction` (ruling 260) runs and whose registry entry
 * ruling 263 added beside revoke's.
 */
const members = "app/(app)/settings/members/actions.ts";

export const rows = [
  {
    module: "app/(app)/actions.ts",
    action: "inviteMemberAction",
    status: "ported",
    surfaces: [{ registry: "invite_organization_member" }],
  },
  {
    module: "app/(app)/settings/appearance/actions.ts",
    action: "updateOrganizationAppearanceAction",
    status: "ported",
    surfaces: [{ registry: "appearance.update_organization_defaults.v1" }],
  },
  {
    module: members,
    action: "setOrganizationMemberAction",
    status: "ported",
    surfaces: [{ registry: "set_organization_member" }],
  },
  {
    module: members,
    action: "revokeInvitationAction",
    status: "ported",
    surfaces: [{ registry: "revoke_organization_invitation" }],
  },
  {
    module: members,
    action: "resendInvitationAction",
    status: "ported",
    surfaces: [{ registry: "resend_organization_invitation" }],
  },
];
