import { z } from "zod";

import type {
  EventFactory,
  EventSchemaRegistry,
} from "../events/event-factory.js";
import { auditActor } from "../operators/operator-types.js";
import {
  type AuthorizedCommandContext,
  requireOrganization,
  requireScope,
} from "../shared/authorization.js";
import type { CommandDefinition } from "../shared/command.js";
import { DomainError } from "../shared/errors.js";
import type { JsonObject } from "../shared/idempotency.js";
import {
  type RoutingRepository,
  routingMember,
  routingRuleInputSchema,
  routingRuleSpecificity,
} from "./routing-service.js";

const routingEventSchema = z.object({
  changeType: z.enum(["created", "updated", "disabled"]),
  ruleId: z.uuid(),
  version: z.number().int().positive(),
  decision: z.enum(["allow", "deny"]),
  sourceKind: z.enum(["project", "human_direct"]),
  sourceProjectId: z.uuid().nullable(),
  targetProjectId: z.uuid(),
  enabled: z.boolean(),
});

export function registerRoutingEventSchemas(registry: EventSchemaRegistry) {
  return registry.register("routing_rule.changed.v1", routingEventSchema);
}

const updateInputSchema = routingRuleInputSchema.safeExtend({
  ruleId: z.uuid(),
});
const disableInputSchema = z.object({
  organizationId: z.uuid(),
  ruleId: z.uuid(),
});

/**
 * The input schema each command in this module parses with, by command name.
 * These are the same objects the definitions below call `parse` on.
 */
export const routingCommandInputSchemas = {
  create_routing_rule: routingRuleInputSchema,
  update_routing_rule: updateInputSchema,
  disable_routing_rule: disableInputSchema,
} as const;

function ruleResult(rule: {
  id: string;
  version: number;
  decision: "allow" | "deny";
  sourceKind: "project" | "human_direct";
  sourceProjectId?: string;
  targetProjectId: string;
  enabled: boolean;
}): JsonObject {
  return {
    id: rule.id,
    version: rule.version,
    decision: rule.decision,
    sourceKind: rule.sourceKind,
    sourceProjectId: rule.sourceProjectId ?? null,
    targetProjectId: rule.targetProjectId,
    enabled: rule.enabled,
  };
}

/**
 * The `routing_rule.changed.v1` payload. Its schema names the rule `ruleId`;
 * the command's answer to its caller (`ruleResult`) names the same value
 * `id`. Spreading the answer into the payload failed the schema, so every
 * rule command was refused as "Event payload is invalid" from v1 until Plan
 * 13's F.2.1, whose first real-database suite found it.
 */
function ruleEventData(
  changeType: "created" | "updated" | "disabled",
  rule: Parameters<typeof ruleResult>[0],
): JsonObject {
  const { id: _answerId, ...rest } = ruleResult(rule);
  return { changeType, ruleId: rule.id, ...rest };
}

/**
 * The rule commands' authorisation: `routing:manage`, the context's
 * organisation, the member (`routingMember`: the person, or an
 * organisation-wide operator's issuing member, through F.3's
 * `memberAuthority`), and then the repository's rule for that member, an
 * active owner or admin of the active organisation. The repository is asked
 * about the member, never about `context.actor`, which for an operator is
 * `operator:<lineage>` (Plan 13, F.2.1).
 */
async function authorizeManager(
  repository: RoutingRepository,
  context: AuthorizedCommandContext,
  organizationId: string,
) {
  requireScope(context, "routing:manage");
  requireOrganization(context, organizationId);
  const member = routingMember(context);
  if (
    !(await repository.canManage(organizationId, { type: "user", id: member }))
  ) {
    throw new DomainError(
      "forbidden",
      "Organization routing authority is required",
    );
  }
}

export function createRoutingCommandDefinitions(dependencies: {
  events: EventFactory;
  createId?: () => string;
}): Array<CommandDefinition<unknown, JsonObject>> {
  const create: CommandDefinition<unknown, JsonObject> = {
    name: "create_routing_rule",
    parse: (input) => routingRuleInputSchema.parse(input),
    async authorize(context, rawInput, uow) {
      const input = routingRuleInputSchema.parse(rawInput);
      await authorizeManager(
        uow.port<RoutingRepository>("routing"),
        context,
        input.organizationId,
      );
    },
    async execute(uow, context, rawInput, meta) {
      if (meta.expectedVersion !== 0) {
        throw new DomainError(
          "version_conflict",
          "Routing rule creation expects version zero",
        );
      }
      const input = routingRuleInputSchema.parse(rawInput);
      if ((input.sourceKind === "project") !== Boolean(input.sourceProjectId)) {
        throw new DomainError(
          "validation_failed",
          "Routing source project is invalid",
        );
      }
      const repository = uow.port<RoutingRepository>("routing");
      // The rule's author is who acted, as an audit row names it
      // (`auditActor`): `user:<id>` for a person, and
      // `service:operator:<lineage>` for an operator, never its member.
      const author = auditActor(context);
      const rule = await repository.createRule({
        ...input,
        specificity: routingRuleSpecificity(input),
        createdBy: `${author.actorType}:${author.actorId}`,
      });
      const event = dependencies.events.create(context, {
        type: "routing_rule.changed.v1",
        schemaVersion: 1,
        aggregateType: "routing_rule",
        aggregateId: rule.id,
        aggregateVersion: rule.version,
        projectId: rule.targetProjectId,
        causationId: context.correlationId,
        data: ruleEventData("created", rule),
      });
      return {
        result: ruleResult(rule),
        aggregateId: rule.id,
        events: [event],
      };
    },
  };

  const update: CommandDefinition<unknown, JsonObject> = {
    name: "update_routing_rule",
    parse: (input) => updateInputSchema.parse(input),
    async authorize(context, rawInput, uow) {
      const input = updateInputSchema.parse(rawInput);
      await authorizeManager(
        uow.port<RoutingRepository>("routing"),
        context,
        input.organizationId,
      );
    },
    async execute(uow, context, rawInput, meta) {
      const input = updateInputSchema.parse(rawInput);
      const repository = uow.port<RoutingRepository>("routing");
      const rule = await repository.updateRule(
        input.ruleId,
        input.organizationId,
        meta.expectedVersion,
        {
          sourceKind: input.sourceKind,
          sourceProjectId: input.sourceProjectId,
          targetProjectId: input.targetProjectId,
          decision: input.decision,
          requestTypes: input.requestTypes,
          laneIds: input.laneIds,
          priorities: input.priorities,
          humanRoles: input.humanRoles,
          agentPrincipalIds: input.agentPrincipalIds,
          specificity: routingRuleSpecificity(input),
          enabled: input.enabled,
        },
      );
      const event = dependencies.events.create(context, {
        type: "routing_rule.changed.v1",
        schemaVersion: 1,
        aggregateType: "routing_rule",
        aggregateId: rule.id,
        aggregateVersion: rule.version,
        projectId: rule.targetProjectId,
        causationId: context.correlationId,
        data: ruleEventData("updated", rule),
      });
      return {
        result: ruleResult(rule),
        aggregateId: rule.id,
        events: [event],
      };
    },
  };

  const disable: CommandDefinition<unknown, JsonObject> = {
    name: "disable_routing_rule",
    parse: (input) => disableInputSchema.parse(input),
    async authorize(context, rawInput, uow) {
      const input = disableInputSchema.parse(rawInput);
      await authorizeManager(
        uow.port<RoutingRepository>("routing"),
        context,
        input.organizationId,
      );
    },
    async execute(uow, context, rawInput, meta) {
      const input = disableInputSchema.parse(rawInput);
      const repository = uow.port<RoutingRepository>("routing");
      const rule = await repository.disableRule(
        input.ruleId,
        input.organizationId,
        meta.expectedVersion,
      );
      const event = dependencies.events.create(context, {
        type: "routing_rule.changed.v1",
        schemaVersion: 1,
        aggregateType: "routing_rule",
        aggregateId: rule.id,
        aggregateVersion: rule.version,
        projectId: rule.targetProjectId,
        causationId: context.correlationId,
        data: ruleEventData("disabled", rule),
      });
      return {
        result: ruleResult(rule),
        aggregateId: rule.id,
        events: [event],
      };
    },
  };
  return [create, update, disable];
}
