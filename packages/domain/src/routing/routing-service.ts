import { z } from "zod";
import { memberAuthority } from "../operators/operator-types.js";
import type { FoundationQueryRepository } from "../queries/foundation-query.js";
import type {
  ActorRef,
  AuthorizedCommandContext,
} from "../shared/authorization.js";
import {
  requireAgentProject,
  requireOrganization,
  requireScope,
} from "../shared/authorization.js";
import { DomainError } from "../shared/errors.js";
import { evaluateRoute } from "./evaluate-route.js";
import {
  type RouteDecision,
  type RoutingPrincipal,
  type RoutingRule,
  requestPriorities,
  requestTypes,
} from "./routing-types.js";

export const routingRuleInputSchema = z
  .object({
    organizationId: z.uuid(),
    sourceKind: z.enum(["project", "human_direct"]),
    sourceProjectId: z.uuid().optional(),
    targetProjectId: z.uuid(),
    decision: z.enum(["allow", "deny"]),
    requestTypes: z
      .array(z.enum(requestTypes))
      .max(requestTypes.length)
      .default([]),
    laneIds: z.array(z.uuid()).max(100).default([]),
    priorities: z
      .array(z.enum(requestPriorities))
      .max(requestPriorities.length)
      .default([]),
    humanRoles: z
      .array(z.enum(["owner", "admin", "member"]))
      .max(3)
      .default([]),
    agentPrincipalIds: z.array(z.uuid()).max(100).default([]),
    enabled: z.boolean().default(true),
  })
  .superRefine((value, context) => {
    if ((value.sourceKind === "project") !== Boolean(value.sourceProjectId)) {
      context.addIssue({
        code: "custom",
        message: "Routing source project is invalid",
        path: ["sourceProjectId"],
      });
    }
    for (const field of [
      "requestTypes",
      "laneIds",
      "priorities",
      "humanRoles",
      "agentPrincipalIds",
    ] as const) {
      if (new Set(value[field]).size !== value[field].length) {
        context.addIssue({
          code: "custom",
          message: "Routing constraints must be unique",
          path: [field],
        });
      }
    }
    if (value.humanRoles.length > 0 && value.agentPrincipalIds.length > 0) {
      context.addIssue({
        code: "custom",
        message:
          "A routing rule cannot target human roles and agent principals together",
        path: ["agentPrincipalIds"],
      });
    }
    if (
      value.sourceKind === "human_direct" &&
      value.agentPrincipalIds.length > 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Human-direct rules cannot target agent principals",
        path: ["agentPrincipalIds"],
      });
    }
  });

export interface RoutingRepository {
  canManage(organizationId: string, actor: ActorRef): Promise<boolean>;
  listRules(organizationId: string): Promise<RoutingRule[]>;
  createRule(
    input: Omit<RoutingRule, "id" | "version"> & { createdBy: string },
  ): Promise<RoutingRule>;
  updateRule(
    id: string,
    organizationId: string,
    expectedVersion: number,
    input: Omit<RoutingRule, "id" | "organizationId" | "version">,
  ): Promise<RoutingRule>;
  disableRule(
    id: string,
    organizationId: string,
    expectedVersion: number,
  ): Promise<RoutingRule>;
}

export function routingRuleSpecificity(
  input: z.infer<typeof routingRuleInputSchema>,
) {
  const constrainedSets = [
    ...(input.sourceProjectId ? [[input.sourceProjectId]] : []),
    input.requestTypes,
    input.laneIds,
    input.priorities,
    input.humanRoles,
    input.agentPrincipalIds,
  ].filter((values) => values.length > 0);
  return (
    constrainedSets.length * 1_000 +
    constrainedSets.reduce(
      (score, values) => score + 100 - Math.min(100, values.length),
      0,
    )
  );
}

export class RoutingService {
  constructor(private readonly repository: RoutingRepository) {}

  async createRule(context: AuthorizedCommandContext, rawInput: unknown) {
    requireScope(context, "routing:manage");
    const input = routingRuleInputSchema.parse(rawInput);
    requireOrganization(context, input.organizationId);
    if (
      !(await this.repository.canManage(input.organizationId, context.actor))
    ) {
      throw new DomainError(
        "forbidden",
        "Organization routing authority is required",
      );
    }
    if ((input.sourceKind === "project") !== Boolean(input.sourceProjectId)) {
      throw new DomainError(
        "validation_failed",
        "Routing source project is invalid",
      );
    }
    return this.repository.createRule({
      ...input,
      specificity: routingRuleSpecificity(input),
      createdBy: `${context.actor.type}:${context.actor.id}`,
    });
  }
}

/**
 * The member a routing capability acts for: the one whose role decides
 * whether they may manage the organisation's rules, and whose standing a
 * route is evaluated under. It is `memberAuthority(context)` (Plan 13, F.3,
 * F3-2): the person for a `user` actor, the issuing member for a well-formed
 * operator context, and nobody — so `forbidden` before any repository runs —
 * for an agent, for any other service actor, and for a context that claims
 * to be an operator's without being one.
 *
 * Routing rules and a route's evaluation are the organisation's, so an
 * operator credential bound to a project is refused here too
 * (`requireAgentProject` with no project allowed: it lets a person and an
 * organisation-wide operator through, and confines every other claim to the
 * operator kind).
 *
 * A `user` actor is taken as the person it names. That includes the MCP
 * route's provisioning delegation, which presents the delegating person as a
 * `user` actor holding `humanScopes`; it cannot reach these capabilities
 * because no MCP tool names them (each registry entry's `mcpTool` is null),
 * and `/api/v1` authenticates no `user` actor.
 */
export function routingMember(context: AuthorizedCommandContext) {
  const member = memberAuthority(context);
  if (!member)
    throw new DomainError(
      "forbidden",
      "Routing requires a person or an operator credential",
    );
  requireAgentProject(context);
  return member.userId;
}

const routeEvaluationTarget = {
  organizationId: z.uuid(),
  /** Absent for a request raised directly by a person (`human_direct`). */
  sourceProjectId: z.uuid().optional(),
  targetProjectId: z.uuid(),
  requestType: z.enum(requestTypes),
  priority: z.enum(requestPriorities),
};

/**
 * What the route evaluation entry takes. `test` is the routing settings
 * tester: it may name a lane and an agent principal to evaluate for, and
 * evaluates any source project. `preview` is the request form's preview: it
 * evaluates for the member alone, and only a source project the member may
 * represent.
 */
export const routeEvaluationInputSchema = z.discriminatedUnion("purpose", [
  z.strictObject({
    purpose: z.literal("test"),
    ...routeEvaluationTarget,
    laneId: z.uuid().optional(),
    agentPrincipalId: z.uuid().optional(),
  }),
  z.strictObject({
    purpose: z.literal("preview"),
    ...routeEvaluationTarget,
  }),
]);

export type RouteEvaluationRequest = z.input<typeof routeEvaluationInputSchema>;

/** The scope each purpose of the evaluation entry requires. */
export const routeEvaluationScopes = {
  test: "routing:manage",
  preview: "request:create",
} as const;

/**
 * What the evaluation entry reads, each on the caller's transaction:
 * `listRulesForMember` answers null unless the member is active in the active
 * organisation; the two foundation reads answer the member's role and the
 * projects they may represent.
 */
export interface RouteEvaluationSources {
  rules: {
    listRulesForMember(
      userId: string,
      organizationId: string,
    ): Promise<RoutingRule[] | null>;
  };
  members: Pick<
    FoundationQueryRepository,
    "findActiveOrganizationForUser" | "listOrganizationProjects"
  >;
}

/**
 * The one route evaluation entry (Plan 13, F.2.1): the routing tester and the
 * request form's preview both reach it. It evaluates the organisation's
 * routing rules for a route inside that organisation, without writing.
 *
 * It checks, in order: the input; the context's organisation; the member it
 * acts for (`routingMember`: a person, or an organisation-wide operator's
 * issuing member); the purpose's scope
 * (`routeEvaluationScopes`); and that the person is an active member of the
 * active organisation, whose role the evaluation then uses. For a preview
 * with a source project, the member must be able to represent it (an active
 * project, and an owner or admin, or an active member of the project);
 * otherwise the preview answers `no_matching_permission` at policy version 0
 * without reading a rule, as the preview always has. The principal evaluated
 * is the member, carrying the context's scopes, or, for a test that names
 * one, the agent principal, carrying the same scopes. For an operator those
 * are the credential's scopes, not the member's: a person-direct route
 * evaluated for an operator without `request:create` answers
 * `no_matching_permission`, as it would for a person without it.
 */
export async function evaluateRouteForMember(
  sources: RouteEvaluationSources,
  context: AuthorizedCommandContext,
  rawInput: unknown,
): Promise<RouteDecision> {
  const input = routeEvaluationInputSchema.parse(rawInput);
  requireOrganization(context, input.organizationId);
  const member = routingMember(context);
  requireScope(context, routeEvaluationScopes[input.purpose]);
  const membership = await sources.members.findActiveOrganizationForUser(
    member,
    input.organizationId,
  );
  if (!membership) {
    throw new DomainError(
      "forbidden",
      "Active organization membership is required",
    );
  }
  if (input.purpose === "preview" && input.sourceProjectId) {
    const projects = await sources.members.listOrganizationProjects(
      member,
      input.organizationId,
    );
    const representable = projects.some(
      (project) =>
        project.id === input.sourceProjectId &&
        project.status === "active" &&
        project.canRepresent,
    );
    if (!representable) {
      return {
        allowed: false,
        reason: "no_matching_permission",
        policyVersion: 0,
        evaluatedConstraints: ["source_project"],
      };
    }
  }
  const rules = await sources.rules.listRulesForMember(
    member,
    input.organizationId,
  );
  if (!rules) {
    throw new DomainError(
      "forbidden",
      "Active organization membership is required",
    );
  }
  const principal: RoutingPrincipal =
    input.purpose === "test" && input.agentPrincipalId
      ? { type: "agent", id: input.agentPrincipalId, scopes: context.scopes }
      : {
          type: "user",
          id: member,
          organizationRole: membership.role,
          scopes: context.scopes,
        };
  return evaluateRoute(
    {
      sourceOrganizationId: input.organizationId,
      targetOrganizationId: input.organizationId,
      source: input.sourceProjectId
        ? { kind: "project", projectId: input.sourceProjectId }
        : { kind: "human_direct" },
      targetProjectId: input.targetProjectId,
      ...(input.purpose === "test" && input.laneId
        ? { laneId: input.laneId }
        : {}),
      requestType: input.requestType,
      priority: input.priority,
      principal,
    },
    rules,
  );
}
