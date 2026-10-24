import { z } from "zod";

import {
  auditRecordActor,
  type FoundationRepository,
  type OrganizationRole,
} from "../audit/audit-repository.js";
import type { EventFactory } from "../events/event-factory.js";
import { memberAuthority } from "../operators/operator-types.js";
import {
  type ActorRef,
  type AuthorizedCommandContext,
  requireOrganization,
  requireScope,
} from "../shared/authorization.js";
import type { CommandDefinition, CommandMeta } from "../shared/command.js";
import { DomainError } from "../shared/errors.js";
import type { JsonObject } from "../shared/idempotency.js";
import type { UnitOfWork } from "../shared/unit-of-work.js";
import { utf16Max } from "../shared/zod-compat.js";
import {
  createOrganizationInvitation,
  defaultInvitationTokenHash,
  invitationCreatedEventData,
  organizationInvitationCreatedEvent,
  parseOrganizationInvitationInput,
  requireInvitationAuthority,
} from "./organization-service.js";

/*
  Organisation administration, as commands on the tenant bus (Plan 13, F.2.7):
  inviting a member, changing a member's role or access, and revoking a
  pending invitation. The members page's forms dispatch these, and so does
  `/api/v1`, for an operator credential only: each has a capability registry
  entry naming `credentialKinds: ["operator"]` and no MCP tool.

  Each one checks `members:manage`, the organisation, the member whose
  authority it runs with (`memberAuthority`: the signed-in person, or an
  operator's issuing member), and that the context is bound to no project,
  because every row these commands touch is the organisation's. It then runs
  the role rule of the write it guards, for that member, before the bus
  answers a replay or runs the write. So a replay is refused, not answered,
  once the role is gone. The rule follows the member's role alone: an
  operator issued by an owner may do what that owner may, owners included. Changing a member and revoking an invitation run that
  rule again inside the write, on the same rows. Inviting runs it once, here:
  `requireInvitationAuthority` reads the organisation and the inviter's
  membership `FOR SHARE`, and those locks hold until the bus's transaction
  ends, so the role it saw is the role the invitation is written under.

  Inviting runs on the foundation repository through
  `createOrganizationInvitation`, the invitation rules
  `OrganizationService.inviteUser` also runs (X15): it answers a pending
  invitation, refuses an active member (`already_member`) or an address that
  has an account (`existing_account`), and otherwise creates the invitation or
  renews the address's revoked, expired or accepted one. It returns the
  `organization.invitation_created.v1` event of a creation or a renewal to the
  bus: the bus writes it and its outbox row, and its after-commit dispatch
  starts the invitation's email.
  The other two write through the organisation management repository, which
  records its own audit row, event and outbox row, as it did when the forms
  called it directly; they return no event, and the scheduled outbox repair
  delivers theirs. Every audit row and event records who acted: a person as
  `user`, an operator as the `service` actor `operator:<lineage>` (F3-2).
*/

/** The scope every organisation administration command requires. */
export const membersScope = "members:manage";

/** The port set member and revoke invitation write through. */
export const organizationManagementPortName = "organizationManagement";

/** The port inviting writes through: the foundation repository. */
export const organizationFoundationPortName = "foundation";

export const inviteOrganizationMemberCommandName = "invite_organization_member";
export const setOrganizationMemberCommandName = "set_organization_member";
export const revokeOrganizationInvitationCommandName =
  "revoke_organization_invitation";

const organizationRole = z.enum(["owner", "admin", "member"]);

const inviteInput = z.strictObject({
  organizationId: z.uuid(),
  email: z.string().check(utf16Max(320)),
  role: organizationRole,
  expiresInSeconds: z.number().int().optional(),
});
const memberInput = z.strictObject({
  organizationId: z.uuid(),
  userId: z.string().min(1).check(utf16Max(255)),
  role: organizationRole,
  status: z.enum(["active", "revoked"]),
});
const invitationInput = z.strictObject({
  organizationId: z.uuid(),
  invitationId: z.uuid(),
});

/**
 * The input schema each organisation administration command parses with, by
 * command name. These are the same objects the definitions below call `parse`
 * on.
 */
export const organizationAdministrationCommandInputSchemas = {
  [inviteOrganizationMemberCommandName]: inviteInput,
  [setOrganizationMemberCommandName]: memberInput,
  [revokeOrganizationInvitationCommandName]: invitationInput,
} as const;

/** Whose authority a write runs under (`userId`, a person), and where. */
export interface OrganizationManagementTarget {
  organizationId: string;
  userId: string;
}

/**
 * A write: its target, the version it expects, its correlation, and the
 * context's actor. `userId` is the member whose authority the write runs
 * with; `actor` is who acts — that member for a person, the `service` actor
 * `operator:<lineage>` for an operator — and is what the write records.
 */
export interface OrganizationManagementMutation
  extends OrganizationManagementTarget {
  correlationId: string;
  expectedVersion: number;
  actor: ActorRef;
}

/**
 * The organisation management repository, as the commands reach it through the
 * unit of work. Each `authorize…` throws unless the acting person
 * (`target.userId`) may make the change: an active owner or admin of the
 * active organisation, and an owner where the change concerns an owner. It
 * throws `not_found` for a member or invitation the organisation does not
 * hold. Each write checks the same again, then the version and the write's own
 * rules, before it writes.
 */
export interface OrganizationManagementPort {
  authorizeMemberChange(
    target: OrganizationManagementTarget,
    change: { userId: string; role: OrganizationRole },
  ): Promise<void>;
  authorizeInvitationRevocation(
    target: OrganizationManagementTarget,
    invitationId: string,
  ): Promise<void>;
  setMember(
    mutation: OrganizationManagementMutation,
    change: {
      userId: string;
      role: OrganizationRole;
      status: "active" | "revoked";
    },
  ): Promise<{ id: string; role: string; status: string; version: number }>;
  revokeInvitation(
    mutation: OrganizationManagementMutation,
    invitationId: string,
  ): Promise<{ id: string; version: number }>;
}

function management(uow: UnitOfWork) {
  return uow.port<OrganizationManagementPort>(organizationManagementPortName);
}

function foundation(uow: UnitOfWork) {
  return uow.port<FoundationRepository>(organizationFoundationPortName);
}

/**
 * The member an organisation administration command acts for: the one whose
 * role authorises it, and whom the repository's checks name. It is
 * `memberAuthority(context)` (Plan 13, F.3, F3-2): the person for a `user`
 * actor, the issuing member for a well-formed operator context, and nobody —
 * so `forbidden` before any repository runs — for an agent, for any other
 * service actor, and for a context that claims to be an operator's without
 * being one.
 *
 * A `user` actor is taken as the person it names. That includes the MCP
 * route's provisioning delegation, which presents the delegating person as a
 * `user` actor holding `humanScopes` (so `members:manage`); it cannot reach
 * these commands because no MCP tool names them (each registry entry's
 * `mcpTool` is null), and `/api/v1` authenticates no `user` actor.
 */
function actingMember(context: AuthorizedCommandContext) {
  const member = memberAuthority(context);
  if (!member)
    throw new DomainError(
      "forbidden",
      "Organization administration requires a person or an operator credential",
    );
  return member.userId;
}

/**
 * The target a command runs on, after the checks that need no repository:
 * the scope, the organisation, the acting member, and that the context is
 * bound to no project. A person's context carries no project; an operator
 * credential bound to a project is refused here, because members,
 * invitations and the organisation's defaults belong to no project.
 */
function administrationTarget(
  context: AuthorizedCommandContext,
  organizationId: string,
): OrganizationManagementTarget {
  requireScope(context, membersScope);
  requireOrganization(context, organizationId);
  const userId = actingMember(context);
  if (context.projectId)
    throw new DomainError(
      "forbidden",
      "Organization administration requires a credential bound to no project",
    );
  return { organizationId, userId };
}

function mutation(
  context: AuthorizedCommandContext,
  target: OrganizationManagementTarget,
  meta: CommandMeta,
): OrganizationManagementMutation {
  return {
    ...target,
    correlationId: context.correlationId,
    expectedVersion: meta.expectedVersion,
    actor: context.actor,
  };
}

export function createOrganizationAdministrationCommandDefinitions(dependencies: {
  events: EventFactory;
  invitationTokenHash?: () => string;
}): Array<CommandDefinition<unknown, JsonObject>> {
  const tokenHash =
    dependencies.invitationTokenHash ?? defaultInvitationTokenHash;

  const invite: CommandDefinition<unknown, JsonObject> = {
    name: inviteOrganizationMemberCommandName,
    parse: (input) => inviteInput.parse(input),
    async authorize(context, rawInput, uow) {
      const input = inviteInput.parse(rawInput);
      const target = administrationTarget(context, input.organizationId);
      const invitation = parseOrganizationInvitationInput(input);
      await foundation(uow).transaction((tx) =>
        requireInvitationAuthority(tx, {
          organizationId: target.organizationId,
          userId: target.userId,
          role: invitation.role,
        }),
      );
    },
    async execute(uow, context, rawInput, meta) {
      const input = inviteInput.parse(rawInput);
      const target = administrationTarget(context, input.organizationId);
      // A renewal expects 0 as well: the form cannot know the version of the
      // row it renews. The renewal is guarded instead by the row lock
      // `findInvitation` takes and `renewInvitation`'s version check.
      if (meta.expectedVersion !== 0) {
        throw new DomainError(
          "version_conflict",
          "A new invitation expects version 0",
        );
      }
      const parsed = parseOrganizationInvitationInput(input);
      const outcome = await foundation(uow).transaction((tx) =>
        createOrganizationInvitation(tx, {
          ...parsed,
          userId: target.userId,
          actor: auditRecordActor(context),
          correlationId: context.correlationId,
          tokenHash,
        }),
      );
      const { invitation, created } = outcome;
      // A renewal is evented like a creation, at the invitation's new version,
      // with `renewedFrom`: its outbox row sends the email.
      const events = created
        ? [
            dependencies.events.create(context, {
              type: organizationInvitationCreatedEvent,
              schemaVersion: 1,
              aggregateType: "invitation",
              aggregateId: invitation.id,
              aggregateVersion: invitation.version,
              causationId: context.correlationId,
              data: invitationCreatedEventData(
                invitation,
                outcome.outcome === "renewed" ? outcome.renewedFrom : undefined,
              ),
            }),
          ]
        : [];
      return {
        // No address: the result is stored as the receipt, and answers a
        // replay; the caller already holds the address it sent.
        result: {
          id: invitation.id,
          role: invitation.role,
          expiresAt: invitation.expiresAt.toISOString(),
          created,
        },
        aggregateId: invitation.id,
        events,
      };
    },
  };

  const setMember: CommandDefinition<unknown, JsonObject> = {
    name: setOrganizationMemberCommandName,
    parse: (input) => memberInput.parse(input),
    async authorize(context, rawInput, uow) {
      const input = memberInput.parse(rawInput);
      await management(uow).authorizeMemberChange(
        administrationTarget(context, input.organizationId),
        { userId: input.userId, role: input.role },
      );
    },
    async execute(uow, context, rawInput, meta) {
      const input = memberInput.parse(rawInput);
      const target = administrationTarget(context, input.organizationId);
      const result = await management(uow).setMember(
        mutation(context, target, meta),
        { userId: input.userId, role: input.role, status: input.status },
      );
      return {
        result: {
          id: result.id,
          role: result.role,
          status: result.status,
          version: result.version,
        },
        aggregateId: result.id,
        events: [],
      };
    },
  };

  const revokeInvitation: CommandDefinition<unknown, JsonObject> = {
    name: revokeOrganizationInvitationCommandName,
    parse: (input) => invitationInput.parse(input),
    async authorize(context, rawInput, uow) {
      const input = invitationInput.parse(rawInput);
      await management(uow).authorizeInvitationRevocation(
        administrationTarget(context, input.organizationId),
        input.invitationId,
      );
    },
    async execute(uow, context, rawInput, meta) {
      const input = invitationInput.parse(rawInput);
      const target = administrationTarget(context, input.organizationId);
      const result = await management(uow).revokeInvitation(
        mutation(context, target, meta),
        input.invitationId,
      );
      return {
        result: { id: result.id, version: result.version },
        aggregateId: result.id,
        events: [],
      };
    },
  };

  return [invite, setMember, revokeInvitation];
}
