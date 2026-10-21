import { z } from "zod";

import {
  type AuditRecordInput,
  auditRecordActor,
} from "../audit/audit-repository.js";
import type { EventFactory } from "../events/event-factory.js";
import { memberAuthority } from "../operators/operator-types.js";
import { membersScope } from "../organizations/organization-administration-commands.js";
import {
  type AuthenticatedUserCommandContext,
  type AuthorizedCommandContext,
  assertAuthenticatedUserContext,
  requireOrganization,
  requireScope,
} from "../shared/authorization.js";
import type { CommandDefinition } from "../shared/command.js";
import { DomainError } from "../shared/errors.js";
import type { JsonObject } from "../shared/idempotency.js";
import type { UnitOfWork } from "../shared/unit-of-work.js";
import {
  type AppearancePort,
  type AppearanceUserAuthorizationPort,
  appearancePortName,
} from "./appearance-service.js";
import {
  type AppearanceAxis,
  appearanceAxes,
  appearanceDensitySchema,
  appearanceModeSchema,
  appearanceThemeSchema,
} from "./appearance-types.js";

export const appearancePersonalCommandName = "appearance.update_personal.v1";
export const appearanceOrganizationCommandName =
  "appearance.update_organization_defaults.v1";

export const appearanceOrganizationDefaultsInitializedEvent =
  "appearance.organization_defaults_initialized.v1";
export const appearanceOrganizationDefaultsUpdatedEvent =
  "appearance.organization_defaults_updated.v1";

export const appearanceAggregateType = "organization_appearance";

/** The port name the personal command resolves its session recheck from. */
export const appearanceUserAuthorizationPortName = "commandAuthorization";

const personalReason = "Personal appearance preferences were updated";
const organizationReason = "Organization appearance defaults were updated";

/**
 * Neither schema accepts a user or organization identifier from the caller. The
 * organization command's tenant discriminator is injected server-side from the
 * authenticated context by `withOrganizationAppearanceInput` and validated
 * against that context again in `authorize`.
 */
const personalInputSchema = z.strictObject({
  theme: appearanceThemeSchema.nullable(),
  density: appearanceDensitySchema.nullable(),
  mode: appearanceModeSchema.nullable(),
});

const organizationInputSchema = z.strictObject({
  organizationId: z.uuid(),
  theme: appearanceThemeSchema,
  density: appearanceDensitySchema,
  mode: appearanceModeSchema,
});

/**
 * The input schema each command in this module parses with, by command name,
 * split the way the registries are: the organization command is on the tenant
 * registry, the personal one only on the authenticated-user registry. These
 * are the same objects the definitions below call `parse` on.
 */
export const appearanceCommandInputSchemas = {
  [appearanceOrganizationCommandName]: organizationInputSchema,
} as const;

export const personalAppearanceCommandInputSchemas = {
  [appearancePersonalCommandName]: personalInputSchema,
} as const;

export type PersonalAppearanceInput = z.infer<typeof personalInputSchema>;
export type OrganizationAppearanceInput = z.infer<
  typeof organizationInputSchema
>;

/**
 * Builds the organization command input from a validated triple plus the
 * authenticated tenant. Callers never read the tenant from form data.
 */
export function withOrganizationAppearanceInput(
  organizationId: string,
  triple: { theme: string; density: string; mode: string },
) {
  return { organizationId, ...triple };
}

function changedAxes(
  current: Record<AppearanceAxis, string | null>,
  next: Record<AppearanceAxis, string | null>,
) {
  return appearanceAxes
    .filter((axis) => current[axis] !== next[axis])
    .sort() as AppearanceAxis[];
}

function personalResult(row: {
  aggregateId: string | null;
  version: number;
  theme: string | null;
  density: string | null;
  mode: string | null;
  changedFields: readonly string[];
}): JsonObject {
  return {
    aggregateId: row.aggregateId,
    version: row.version,
    theme: row.theme,
    density: row.density,
    mode: row.mode,
    changedFields: [...row.changedFields],
  };
}

function auditRecord(input: {
  organizationId: string | null;
  actor: AuditRecordInput["actor"];
  action: AuditRecordInput["action"];
  targetType: AuditRecordInput["targetType"];
  targetId: string;
  reason: string;
  fieldNames: readonly string[];
  correlationId: string;
}): AuditRecordInput {
  return {
    organizationId: input.organizationId,
    actor: input.actor,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    reason: input.reason,
    // Field names only. Values live in the tenant domain event, never here.
    fieldNames: [...input.fieldNames],
    correlationId: input.correlationId,
  };
}

function appearancePort(uow: UnitOfWork) {
  return uow.port<AppearancePort>(appearancePortName);
}

/**
 * `appearance.update_personal.v1`. Registered only on the authenticated-user
 * bus: it has no organization, works for a user with no active membership at
 * all, and appends a global security audit rather than a tenant event.
 */
export function createPersonalAppearanceCommandDefinitions(): Array<
  CommandDefinition<unknown, JsonObject, AuthenticatedUserCommandContext>
> {
  const update: CommandDefinition<
    unknown,
    JsonObject,
    AuthenticatedUserCommandContext
  > = {
    name: appearancePersonalCommandName,
    parse: (input) => personalInputSchema.parse(input),
    async authorize(context, _input, uow) {
      assertAuthenticatedUserContext(context);
      // The session recheck lives in the command rather than in a bus-level
      // hook so the personal contract cannot be weakened by wiring a bus
      // without one. It still runs before any receipt replay.
      await uow
        .port<AppearanceUserAuthorizationPort>(
          appearanceUserAuthorizationPortName,
        )
        .assertCurrentUser(context);
    },
    async execute(uow, context, rawInput, meta) {
      const input = personalInputSchema.parse(rawInput);
      const port = appearancePort(uow);
      const existing = await port.lockUserPreferences(context.actor.id);
      const currentVersion = existing?.version ?? 0;
      if (currentVersion !== meta.expectedVersion) {
        throw new DomainError(
          "version_conflict",
          "Appearance preferences changed in another session",
        );
      }
      const current = {
        theme: existing?.theme ?? null,
        density: existing?.density ?? null,
        mode: existing?.mode ?? null,
      };
      const changed = changedAxes(current, input);
      if (changed.length === 0) {
        // An identical same-value write keeps its receipt but must not move the
        // version or produce an audit record.
        return {
          result: personalResult({
            aggregateId: existing?.aggregateId ?? null,
            version: currentVersion,
            ...current,
            changedFields: [],
          }),
          aggregateId: existing?.aggregateId,
          events: [],
        };
      }

      const saved = existing
        ? await port.updateUserPreferences({
            userId: context.actor.id,
            expectedVersion: currentVersion,
            ...input,
          })
        : await port.createUserPreferences({
            userId: context.actor.id,
            ...input,
          });
      if (!saved) {
        throw new DomainError(
          "version_conflict",
          "Appearance preferences changed in another session",
        );
      }

      await port.appendAuditRecord(
        auditRecord({
          organizationId: null,
          actor: { type: "user", userId: context.actor.id },
          action: "appearance.personal_preferences_updated",
          targetType: "user_appearance",
          targetId: saved.aggregateId,
          reason: personalReason,
          fieldNames: changed,
          correlationId: context.correlationId,
        }),
      );

      return {
        result: personalResult({
          aggregateId: saved.aggregateId,
          version: saved.version,
          theme: saved.theme,
          density: saved.density,
          mode: saved.mode,
          changedFields: changed,
        }),
        aggregateId: saved.aggregateId,
        events: [],
      };
    },
  };

  return [update];
}

/**
 * The member whose authority the organisation appearance command runs with:
 * `memberAuthority(context)` (Plan 13, F.3, F3-2) — the signed-in person, or
 * an operator credential's issuing member. Throws `forbidden` for every other
 * actor (an agent, any other service, a context that claims to be an
 * operator's without being one), before anything is locked.
 */
function organizationAppearanceMember(context: AuthorizedCommandContext) {
  const member = memberAuthority(context);
  if (!member)
    throw new DomainError(
      "forbidden",
      "Organization appearance defaults require a person or an operator credential",
    );
  return member.userId;
}

/**
 * `appearance.update_organization_defaults.v1`. Stays on the tenant core
 * registry. The members page's appearance form dispatches it, and so does
 * `/api/v1`, for an operator credential only (its registry entry names
 * `credentialKinds: ["operator"]` and no MCP tool). It admits a person and an
 * operator credential and no other actor, requires `members:manage` (F.2.7's
 * scope, which the web's `humanScopes` gives every person), refuses a context
 * bound to a project, and then requires that the member it acts for is an
 * active owner of an active organization. It binds its receipt input to the
 * server-injected tenant so one actor/key pair cannot replay another
 * organization's update. Its audit row records who acted — a person as
 * `user`, an operator as the `service` actor `operator:<lineage>` — and the
 * defaults row names the member as its last updater, the column being a
 * reference to the organisation's memberships.
 */
export function createAppearanceCommandDefinitions(dependencies: {
  events: EventFactory;
}): Array<CommandDefinition<unknown, JsonObject>> {
  const update: CommandDefinition<unknown, JsonObject> = {
    name: appearanceOrganizationCommandName,
    parse: (input) => organizationInputSchema.parse(input),
    async authorize(context: AuthorizedCommandContext, rawInput, uow) {
      const userId = organizationAppearanceMember(context);
      const input = organizationInputSchema.parse(rawInput);
      requireScope(context, membersScope);
      requireOrganization(context, input.organizationId);
      if (context.projectId)
        throw new DomainError(
          "forbidden",
          "Organization appearance defaults require a credential bound to no project",
        );
      // The bus-level authorization has locked the session (a person) or the
      // operator credential; organization then exact membership follow, in
      // that fixed order, before the row lock.
      const authorization = await appearancePort(
        uow,
      ).lockOrganizationAuthorization({
        organizationId: input.organizationId,
        userId,
      });
      if (
        !authorization.organization ||
        authorization.organization.status !== "active" ||
        !authorization.membership ||
        authorization.membership.status !== "active" ||
        authorization.membership.role !== "owner"
      ) {
        throw new DomainError(
          "forbidden",
          "Organization appearance ownership is required",
        );
      }
    },
    async execute(uow, context, rawInput, meta) {
      const input = organizationInputSchema.parse(rawInput);
      const port = appearancePort(uow);
      const existing = await port.lockOrganizationDefaults(
        input.organizationId,
      );
      if (!existing) {
        // Version-1 initialization belongs to migration 0014's backfill and its
        // membership trigger. A command must never invent a second aggregate
        // identity for the same tenant.
        throw new DomainError(
          "conflict",
          "Organization appearance defaults are not initialized",
        );
      }
      if (existing.version !== meta.expectedVersion) {
        throw new DomainError(
          "version_conflict",
          "Appearance preferences changed in another session",
        );
      }
      const before = {
        theme: existing.theme,
        density: existing.density,
        mode: existing.mode,
      };
      const after = {
        theme: input.theme,
        density: input.density,
        mode: input.mode,
      };
      const changed = changedAxes(before, after);
      if (changed.length === 0) {
        return {
          result: {
            aggregateId: existing.aggregateId,
            organizationId: existing.organizationId,
            version: existing.version,
            ...before,
            changedFields: [],
          },
          aggregateId: existing.aggregateId,
          events: [],
        };
      }

      const saved = await port.updateOrganizationDefaults({
        organizationId: input.organizationId,
        expectedVersion: existing.version,
        ...after,
        lastUpdatedByUserId: organizationAppearanceMember(context),
      });
      if (!saved) {
        throw new DomainError(
          "version_conflict",
          "Appearance preferences changed in another session",
        );
      }

      await port.appendAuditRecord(
        auditRecord({
          organizationId: input.organizationId,
          actor: auditRecordActor(context),
          action: "appearance.organization_defaults_updated",
          targetType: "organization_appearance",
          targetId: saved.aggregateId,
          reason: organizationReason,
          fieldNames: changed,
          correlationId: context.correlationId,
        }),
      );

      const event = dependencies.events.create(context, {
        type: appearanceOrganizationDefaultsUpdatedEvent,
        schemaVersion: 1,
        aggregateType: appearanceAggregateType,
        aggregateId: saved.aggregateId,
        // Contiguous with the version-1 initialization envelope 0014 wrote.
        aggregateVersion: saved.version,
        causationId: context.correlationId,
        data: {
          organizationId: input.organizationId,
          changedFields: [...changed],
          before,
          after,
        },
      });

      return {
        result: {
          aggregateId: saved.aggregateId,
          organizationId: saved.organizationId,
          version: saved.version,
          ...after,
          changedFields: [...changed],
        },
        aggregateId: saved.aggregateId,
        events: [event],
      };
    },
  };

  return [update];
}
