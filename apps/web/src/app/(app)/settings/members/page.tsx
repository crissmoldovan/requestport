import { randomUUID } from "node:crypto";

import { createFoundationQueryRepository } from "@requestport/db";

import {
  MembersView,
  NoOrganizationSetup,
} from "../../../../components/administration-views.js";
import { getApplicationContext } from "../../../../lib/server-application-context.js";
import { webStorage } from "../../../../lib/server-request-port.js";
import { inviteMemberAction } from "../../actions.js";
import {
  revokeInvitationAction,
  setOrganizationMemberAction,
} from "./actions.js";

export default async function MembersSettingsPage() {
  const context = await getApplicationContext();
  if (!context.currentOrganization) {
    return <NoOrganizationSetup />;
  }
  const storage = webStorage();
  const foundationQueries = createFoundationQueryRepository(storage.db);
  const [members, invitations] = await Promise.all([
    foundationQueries.listOrganizationMembers(
      context.session.user.id,
      context.currentOrganization.id,
    ),
    context.currentOrganization.role === "member"
      ? Promise.resolve([])
      : foundationQueries.listPendingInvitations(
          context.session.user.id,
          context.currentOrganization.id,
        ),
  ]);
  return (
    <MembersView
      currentUserId={context.session.user.id}
      invitationAction={inviteMemberAction}
      invitationIdempotencyKeys={Object.fromEntries(
        invitations.map((invitation) => [invitation.id, randomUUID()]),
      )}
      invitations={invitations}
      memberAction={setOrganizationMemberAction}
      memberIdempotencyKeys={Object.fromEntries(
        members.map((member) => [member.userId, randomUUID()]),
      )}
      members={members}
      organization={context.currentOrganization}
      revokeInvitationAction={revokeInvitationAction}
    />
  );
}
