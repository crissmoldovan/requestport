import { v7 as uuidv7 } from "uuid";
import { z } from "zod";

import type {
  EventFactory,
  EventSchemaRegistry,
} from "../events/event-factory.js";
import {
  agentRevokeScope,
  isOperatorContext,
  memberAuthority,
} from "../operators/operator-types.js";
import type { EnvelopeEncryption } from "../security/envelope-encryption.js";
import { containsSensitiveContent } from "../security/sensitive-content.js";
import {
  type AuthorizedCommandContext,
  requireAgentProject,
  requireOrganization,
  requireScope,
} from "../shared/authorization.js";
import type { CommandDefinition } from "../shared/command.js";
import { DomainError } from "../shared/errors.js";
import type { JsonObject } from "../shared/idempotency.js";
import { utf16Max, utf16Min } from "../shared/zod-compat.js";
import { WorkspaceService } from "../workspaces/workspace-service.js";
import type { WorkspaceRepository } from "../workspaces/workspace-types.js";
import { workspaceRegistrationSchema } from "../workspaces/workspace-types.js";
import type { AgentRepository } from "./agent-types.js";

const principalEventSchema = z.object({
  agentPrincipalId: z.uuid(),
  projectId: z.uuid().nullable(),
  displayName: z.string(),
  slug: z.string(),
  status: z.literal("active"),
});

const principalStatusEventSchema = z.object({
  agentPrincipalId: z.uuid(),
  projectId: z.uuid().nullable(),
  previousStatus: z.enum(["active", "suspended", "revoked"]),
  status: z.enum(["active", "suspended", "revoked"]),
});

const installationEventSchema = z.object({
  installationId: z.uuid(),
  agentPrincipalId: z.uuid(),
  projectId: z.uuid(),
  softwareName: z.string(),
  softwareVersion: z.string(),
  capabilities: z.record(z.string(), z.boolean()),
});

const workspaceEventSchema = z.object({
  workspaceId: z.uuid(),
  agentPrincipalId: z.uuid(),
  projectId: z.uuid(),
  repositoryId: z.uuid(),
  installationId: z.uuid(),
  safeCapabilities: z.record(z.string(), z.boolean()),
  telemetrySchemaVersion: z.number().int().positive(),
});

export function registerAgentEventSchemas(registry: EventSchemaRegistry) {
  return registry
    .register("agent.registered.v1", principalEventSchema)
    .register("agent.status_changed.v1", principalStatusEventSchema)
    .register("agent.installation_registered.v1", installationEventSchema)
    .register("workspace.registered.v1", workspaceEventSchema);
}

const createPrincipalInput = z.object({
  organizationId: z.uuid(),
  projectId: z.uuid().nullable().default(null),
  displayName: z
    .string()
    .trim()
    .min(1)
    .check(utf16Max(160))
    .refine(
      (value) => !containsSensitiveContent(value),
      "Agent name contains private or secret material",
    ),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/u),
  softwareName: z
    .string()
    .trim()
    .min(1)
    .check(utf16Max(160))
    .refine(
      (value) => !containsSensitiveContent(value),
      "Software name contains private or secret material",
    )
    .nullable()
    .default(null),
});

const registerInstallationInput = z.object({
  organizationId: z.uuid(),
  softwareName: z
    .string()
    .trim()
    .min(1)
    .check(utf16Max(160))
    .refine(
      (value) => !containsSensitiveContent(value),
      "Software name contains private or secret material",
    ),
  softwareVersion: z
    .string()
    .trim()
    .min(1)
    .check(utf16Max(160))
    .refine(
      (value) => !containsSensitiveContent(value),
      "Software version contains private or secret material",
    ),
  capabilities: z
    .record(z.string().regex(/^[a-z][a-z0-9_.:-]{0,63}$/u), z.boolean())
    .refine((value) => Object.keys(value).length <= 128, {
      message: "At most 128 capabilities may be registered",
    })
    .default({}),
});

const setPrincipalStatusInput = z.object({
  organizationId: z.uuid(),
  agentPrincipalId: z.uuid(),
  status: z.enum(["active", "suspended", "revoked"]),
  reason: z
    .string()
    .trim()
    .check(utf16Min(10))
    .check(utf16Max(500))
    .refine(
      (value) => !containsSensitiveContent(value),
      "Reason contains private or secret material",
    ),
});

/**
 * The input schema each command in this module parses with, by command name.
 * These are the same objects the definitions below call `parse` on, so a
 * transport describing a command's input reads it from here rather than
 * keeping a copy. A transport that injects a field (`organizationId`, for
 * every one of these) still validates it, because the schema does.
 */
export const agentCommandInputSchemas = {
  create_agent_principal: createPrincipalInput,
  register_agent_installation: registerInstallationInput,
  set_agent_principal_status: setPrincipalStatusInput,
  register_machine_workspace: workspaceRegistrationSchema,
} as const;

/**
 * The input of the two agent administration capabilities that stay off the
 * command bus (Plan 13, F.2.2; `manifest-f2.md` §4, Scope 1): revoking one of
 * an agent's API keys and revoking one of its OAuth grants. Their handlers
 * are core's `revokeAgentCredential` and `revokeAgentOauthGrant`
 * (`packages/core/src/agent-administration.ts`), which parse with these, as
 * the forms did before the schemas moved here, and which
 * `apps/web/src/lib/server-agent-actions.ts` hands the forms; they live in
 * this package so the capability registry can describe what REST sends
 * them. The expected version and the idempotency key travel in the command
 * envelope, not here.
 */
export const agentAdministrationInputSchemas = {
  revoke_agent_credential: z.object({
    organizationId: z.uuid(),
    agentPrincipalId: z.uuid(),
    credentialId: z.uuid(),
  }),
  revoke_agent_oauth_grant: z.object({
    organizationId: z.uuid(),
    agentPrincipalId: z.uuid(),
    grantId: z.uuid(),
    reason: z.string().trim().check(utf16Min(10)).check(utf16Max(500)),
  }),
} as const;

/**
 * The name REST and the handler map know each of F.2.2's two off-bus
 * revocations by: `revoke_agent_credential` and `revoke_agent_oauth_grant`.
 * No other capability off the command bus is named here.
 */
export type AgentAdministrationHandlerName =
  keyof typeof agentAdministrationInputSchemas;

/**
 * The member `set_agent_principal_status` acts for (Plan 13, F.2.2; F3-2):
 * `memberAuthority(context)` — the signed-in person for a `user` actor, the
 * issuing member for a well-formed operator context — and `forbidden` before
 * any repository runs for anything else: an agent, any other service actor,
 * and a context that claims to be an operator's without being one.
 *
 * A `user` actor is taken as the person it names. That includes the MCP
 * route's provisioning delegation, which presents the delegating person as a
 * `user` actor holding `humanScopes` (so `agent:manage`); it cannot reach this
 * command, because no MCP tool names it (its registry entry's `mcpTool` is
 * null) and `/api/v1` authenticates no `user` actor.
 */
function actingMember(context: AuthorizedCommandContext) {
  const member = memberAuthority(context);
  if (!member)
    throw new DomainError(
      "forbidden",
      "Agent administration requires a person or an operator credential",
    );
  return member;
}

/**
 * Ruling 3: an operator credential may suspend a principal and nothing else —
 * not reactivate it, which gives authority back, nor revoke it, which is
 * final. A person may set any status the repository allows.
 */
function requireSuspensionOnly(
  member: { via: "session" | "operator" },
  status: "active" | "suspended" | "revoked",
) {
  if (member.via === "operator" && status !== "suspended")
    throw new DomainError(
      "forbidden",
      "An operator credential may only suspend an agent",
    );
}

/**
 * The scope an agent administration act requires of `context`: `agent:revoke`
 * of an operator, which may only take authority away (ruling 3, F3-4), and
 * `agent:manage` of anyone else, as it always has been.
 */
export function agentAdministrationScope(context: AuthorizedCommandContext) {
  return isOperatorContext(context) ? agentRevokeScope : "agent:manage";
}

export function createAgentCommandDefinitions(dependencies: {
  events: EventFactory;
  encryption?: EnvelopeEncryption;
  createId?: () => string;
}): Array<CommandDefinition<unknown, JsonObject>> {
  const createId = dependencies.createId ?? uuidv7;

  const createPrincipal: CommandDefinition<unknown, JsonObject> = {
    name: "create_agent_principal",
    parse: (input) => createPrincipalInput.parse(input),
    async authorize(context, unknownInput, uow) {
      const input = createPrincipalInput.parse(unknownInput);
      requireScope(context, "agent:manage");
      requireOrganization(context, input.organizationId);
      const repository = uow.port<AgentRepository>("agents");
      if (
        !(await repository.canManage({
          organizationId: input.organizationId,
          projectId: input.projectId,
          actor: context.actor,
        }))
      ) {
        throw new DomainError("forbidden", "Agent management access is denied");
      }
    },
    async execute(uow, context, unknownInput, meta) {
      if (meta.expectedVersion !== 0) {
        throw new DomainError(
          "version_conflict",
          "Creation expected version must be zero",
        );
      }
      if (context.actor.type !== "user") {
        throw new DomainError("forbidden", "A human maintainer is required");
      }
      const input = createPrincipalInput.parse(unknownInput);
      const principal = await uow
        .port<AgentRepository>("agents")
        .createPrincipal({
          id: createId(),
          organizationId: input.organizationId,
          projectId: input.projectId,
          displayName: input.displayName,
          slug: input.slug,
          softwareName: input.softwareName,
          createdByUserId: context.actor.id,
        });
      const event = dependencies.events.create(context, {
        type: "agent.registered.v1",
        schemaVersion: 1,
        aggregateType: "agent_principal",
        aggregateId: principal.id,
        aggregateVersion: 1,
        projectId: principal.projectId ?? undefined,
        causationId: context.correlationId,
        data: {
          agentPrincipalId: principal.id,
          projectId: principal.projectId,
          displayName: principal.displayName,
          slug: principal.slug,
          status: "active",
        },
      });
      return {
        result: {
          id: principal.id,
          projectId: principal.projectId,
          displayName: principal.displayName,
          slug: principal.slug,
          status: principal.status,
        },
        aggregateId: principal.id,
        events: [event],
      };
    },
  };

  const registerInstallation: CommandDefinition<unknown, JsonObject> = {
    name: "register_agent_installation",
    parse: (input) => registerInstallationInput.parse(input),
    async authorize(context, unknownInput) {
      const input = registerInstallationInput.parse(unknownInput);
      requireScope(context, "agent:register");
      requireOrganization(context, input.organizationId);
      if (context.actor.type !== "agent") {
        throw new DomainError("forbidden", "An agent identity is required");
      }
    },
    async execute(uow, context, unknownInput, meta) {
      if (meta.expectedVersion !== 0) {
        throw new DomainError(
          "version_conflict",
          "Creation expected version must be zero",
        );
      }
      if (context.actor.type !== "agent") {
        throw new DomainError("forbidden", "An agent identity is required");
      }
      if (!context.projectId) {
        throw new DomainError(
          "forbidden",
          "A project-bound authorization is required",
        );
      }
      const input = registerInstallationInput.parse(unknownInput);
      const installation = await uow
        .port<AgentRepository>("agents")
        .registerInstallation({
          id: createId(),
          organizationId: input.organizationId,
          agentPrincipalId: context.actor.id,
          authorizationId: context.credentialId,
          delegatedByUserId: context.actor.delegatedBy?.id ?? null,
          projectId: context.projectId,
          softwareName: input.softwareName,
          softwareVersion: input.softwareVersion,
          capabilities: input.capabilities,
        });
      const event = dependencies.events.create(context, {
        type: "agent.installation_registered.v1",
        schemaVersion: 1,
        aggregateType: "agent_installation",
        aggregateId: installation.id,
        aggregateVersion: 1,
        projectId: context.projectId,
        causationId: context.correlationId,
        data: {
          installationId: installation.id,
          agentPrincipalId: installation.agentPrincipalId,
          projectId: context.projectId,
          softwareName: installation.softwareName,
          softwareVersion: installation.softwareVersion,
          capabilities: installation.capabilities,
        },
      });
      return {
        result: {
          id: installation.id,
          agentPrincipalId: installation.agentPrincipalId,
          softwareName: installation.softwareName,
          softwareVersion: installation.softwareVersion,
          capabilities: installation.capabilities,
        },
        aggregateId: installation.id,
        events: [event],
      };
    },
  };

  const setPrincipalStatus: CommandDefinition<unknown, JsonObject> = {
    name: "set_agent_principal_status",
    parse: (input) => setPrincipalStatusInput.parse(input),
    /*
      Plan 13, F.2.2: a person with `agent:manage`, or an operator credential
      with `agent:revoke` acting for its member. An operator may only suspend
      (ruling 3), and one bound to a project only a principal of that
      project. Either way the member must pass `canManage` on the
      principal's project, asked about that member as the person they are,
      so the rule is the same one the form has always applied.
    */
    async authorize(context, unknownInput, uow) {
      const input = setPrincipalStatusInput.parse(unknownInput);
      requireScope(context, agentAdministrationScope(context));
      requireOrganization(context, input.organizationId);
      const member = actingMember(context);
      requireSuspensionOnly(member, input.status);
      const repository = uow.port<AgentRepository>("agents");
      const principal = await repository.findPrincipal(
        input.organizationId,
        input.agentPrincipalId,
      );
      if (principal) requireAgentProject(context, principal.projectId);
      if (
        !principal ||
        !(await repository.canManage({
          organizationId: input.organizationId,
          projectId: principal.projectId,
          actor: { type: "user", id: member.userId },
        }))
      ) {
        throw new DomainError("forbidden", "Agent management access is denied");
      }
    },
    async execute(uow, context, unknownInput, meta) {
      if (meta.expectedVersion < 1) {
        throw new DomainError(
          "version_conflict",
          "Agent version must be positive",
        );
      }
      const input = setPrincipalStatusInput.parse(unknownInput);
      requireSuspensionOnly(actingMember(context), input.status);
      const updated = await uow
        .port<AgentRepository>("agents")
        .setPrincipalStatus({
          organizationId: input.organizationId,
          agentPrincipalId: input.agentPrincipalId,
          expectedVersion: meta.expectedVersion,
          status: input.status,
          actor: context.actor,
          correlationId: context.correlationId,
          reason: input.reason,
        });
      const event = dependencies.events.create(context, {
        type: "agent.status_changed.v1",
        schemaVersion: 1,
        aggregateType: "agent_principal",
        aggregateId: updated.principal.id,
        aggregateVersion: updated.principal.version,
        projectId: updated.principal.projectId ?? undefined,
        causationId: context.correlationId,
        data: {
          agentPrincipalId: updated.principal.id,
          projectId: updated.principal.projectId,
          previousStatus: updated.previousStatus,
          status: updated.principal.status,
        },
      });
      return {
        result: {
          id: updated.principal.id,
          status: updated.principal.status,
          version: updated.principal.version,
        },
        aggregateId: updated.principal.id,
        events: [event],
      };
    },
  };

  const registerWorkspace: CommandDefinition<unknown, JsonObject> = {
    name: "register_machine_workspace",
    parse: (input) => workspaceRegistrationSchema.parse(input),
    async authorize(context) {
      requireScope(context, "agent:register");
      if (!dependencies.encryption) {
        throw new DomainError(
          "configuration_error",
          "Workspace encryption is unavailable",
        );
      }
    },
    async execute(uow, context, input, meta) {
      if (meta.expectedVersion !== 0) {
        throw new DomainError(
          "version_conflict",
          "Creation expected version must be zero",
        );
      }
      if (!dependencies.encryption || context.actor.type !== "agent") {
        throw new DomainError(
          "forbidden",
          "Workspace registration is unavailable",
        );
      }
      const workspace = await new WorkspaceService({
        repository: uow.port<WorkspaceRepository>("workspaces"),
        encryption: dependencies.encryption,
        createId,
      }).register(context, input);
      const event = dependencies.events.create(context, {
        type: "workspace.registered.v1",
        schemaVersion: 1,
        aggregateType: "machine_workspace",
        aggregateId: workspace.id,
        aggregateVersion: 1,
        projectId: workspace.projectId,
        causationId: context.correlationId,
        data: {
          workspaceId: workspace.id,
          agentPrincipalId: context.actor.id,
          projectId: workspace.projectId,
          repositoryId: workspace.repositoryId,
          installationId: workspace.installationId,
          safeCapabilities: workspace.safeCapabilities,
          telemetrySchemaVersion: workspace.telemetrySchemaVersion,
        },
      });
      return {
        result: {
          id: workspace.id,
          projectId: workspace.projectId,
          repositoryId: workspace.repositoryId,
          installationId: workspace.installationId,
          safeCapabilities: workspace.safeCapabilities,
          status: workspace.status,
          telemetrySchemaVersion: workspace.telemetrySchemaVersion,
        },
        aggregateId: workspace.id,
        events: [event],
      };
    },
  };

  return [
    createPrincipal,
    setPrincipalStatus,
    registerInstallation,
    registerWorkspace,
  ];
}
