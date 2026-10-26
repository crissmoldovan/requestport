import { z } from "zod";
import {
  appearanceOrganizationDefaultsInitializedSchema,
  appearanceOrganizationDefaultsUpdatedSchema,
} from "../appearance/appearance-events.js";
import { isoDatetime, utf16Max } from "../shared/zod-compat.js";
import type { EventSchemaRegistry } from "./event-factory.js";

const organizationCreatedSchema = z.object({
  organizationId: z.uuid(),
  name: z.string().min(1),
  slug: z.string().min(1),
  status: z.enum(["active", "suspended", "archived"]),
});

/**
 * Also the event of a renewal, which re-issues an invitation that was no
 * longer pending: to the invitation email and to a webhook subscriber it is a
 * newly issued invitation. `renewedFrom` is present only on a renewal and says
 * what the row was before it. A worker built before the field strips it and
 * still sends the email.
 */
const organizationInvitationCreatedSchema = z.object({
  invitationId: z.uuid(),
  role: z.enum(["owner", "admin", "member"]),
  expiresAt: isoDatetime(),
  renewedFrom: z.enum(["revoked", "expired", "accepted"]).optional(),
});

const organizationInvitationRevokedSchema = z.object({
  invitationId: z.uuid(),
});

const organizationMemberChangedSchema = z.object({
  membershipId: z.uuid(),
  role: z.enum(["owner", "admin", "member"]),
  status: z.enum(["active", "revoked"]),
});

const projectRegisteredSchema = z.object({
  projectId: z.uuid(),
  name: z.string().min(1),
  slug: z.string().min(1),
  keyPrefix: z.string().min(1),
  status: z.enum(["active", "archived"]),
});

const projectUpdatedSchema = z.object({
  projectId: z.uuid(),
  changeType: z.string().min(1),
  fieldNames: z.array(z.string().min(1).check(utf16Max(160))).max(100),
});

const webhookConfigurationSchema = z.object({
  subscriptionId: z.uuid(),
  changeType: z.string().min(1),
  status: z.string().min(1),
});

const slackConfigurationSchema = z.object({
  integration: z.literal("slack"),
  changeType: z.string().min(1),
  status: z.string().min(1),
});

const retentionHoldChangedSchema = z.object({
  category: z.enum(["all", "slack_oauth_state", "slack_action_token"]),
  status: z.enum(["active", "released"]),
});

export function registerConfigurationEventSchemas(
  registry: EventSchemaRegistry,
) {
  return registry
    .register("organization.created.v1", organizationCreatedSchema)
    .register(
      "organization.invitation_created.v1",
      organizationInvitationCreatedSchema,
    )
    .register(
      "organization.invitation_revoked.v1",
      organizationInvitationRevokedSchema,
    )
    .register("organization.member_changed.v1", organizationMemberChangedSchema)
    .register("project.registered.v1", projectRegisteredSchema)
    .register("project.updated.v1", projectUpdatedSchema)
    .register("integration.webhook_changed.v1", webhookConfigurationSchema)
    .register("integration.slack_changed.v1", slackConfigurationSchema)
    .register("retention.hold_changed.v1", retentionHoldChangedSchema)
    .register(
      "appearance.organization_defaults_initialized.v1",
      appearanceOrganizationDefaultsInitializedSchema,
    )
    .register(
      "appearance.organization_defaults_updated.v1",
      appearanceOrganizationDefaultsUpdatedSchema,
    );
}
