import type {
  RouteDecision,
  RouteEvaluationInput,
  RoutingRule,
} from "./routing-types.js";

function includesOrUnconstrained<T>(
  values: readonly T[],
  value: T | undefined,
) {
  return values.length === 0 || (value !== undefined && values.includes(value));
}

function sourceMatches(input: RouteEvaluationInput, rule: RoutingRule) {
  if (rule.sourceKind !== input.source.kind) return false;
  return (
    input.source.kind === "human_direct" ||
    rule.sourceProjectId === input.source.projectId
  );
}

function principalMatches(input: RouteEvaluationInput, rule: RoutingRule) {
  if (
    rule.humanRoles.length > 0 &&
    (input.principal.type !== "user" ||
      !rule.humanRoles.includes(input.principal.organizationRole))
  ) {
    return false;
  }
  if (
    rule.agentPrincipalIds.length > 0 &&
    (input.principal.type !== "agent" ||
      !rule.agentPrincipalIds.includes(input.principal.id))
  ) {
    return false;
  }
  return true;
}

function matchingConstraints(input: RouteEvaluationInput, rule: RoutingRule) {
  return (
    includesOrUnconstrained(rule.requestTypes, input.requestType) &&
    includesOrUnconstrained(rule.laneIds, input.laneId) &&
    includesOrUnconstrained(rule.priorities, input.priority) &&
    principalMatches(input, rule)
  );
}

function evaluatedConstraints(rule: RoutingRule) {
  const constraints: string[] = [];
  if (rule.requestTypes.length > 0) constraints.push("request_type");
  if (rule.laneIds.length > 0) constraints.push("lane");
  if (rule.priorities.length > 0) constraints.push("priority");
  if (rule.humanRoles.length > 0) constraints.push("human_role");
  if (rule.agentPrincipalIds.length > 0) constraints.push("agent_principal");
  return constraints;
}

export function evaluateRoute(
  input: RouteEvaluationInput,
  rules: readonly RoutingRule[],
): RouteDecision {
  const policyVersion = rules.reduce(
    (highest, rule) => Math.max(highest, rule.version),
    0,
  );
  if (input.sourceOrganizationId !== input.targetOrganizationId) {
    return {
      allowed: false,
      reason: "cross_org_denied",
      policyVersion,
      evaluatedConstraints: ["organization"],
    };
  }
  if (
    input.source.kind === "human_direct" &&
    (input.principal.type !== "user" ||
      !input.principal.scopes.has("request:create"))
  ) {
    return {
      allowed: false,
      reason: "no_matching_permission",
      policyVersion,
      evaluatedConstraints: ["human_direct", "request:create"],
    };
  }

  const matches = rules
    .filter(
      (rule) =>
        rule.enabled &&
        rule.organizationId === input.targetOrganizationId &&
        rule.targetProjectId === input.targetProjectId &&
        sourceMatches(input, rule) &&
        matchingConstraints(input, rule),
    )
    .sort(
      (left, right) =>
        right.specificity - left.specificity ||
        (left.decision === right.decision
          ? left.id.localeCompare(right.id)
          : left.decision === "deny"
            ? -1
            : 1),
    );
  const winning = matches[0];
  if (!winning) {
    return {
      allowed: true,
      reason: "default_same_org",
      policyVersion,
      evaluatedConstraints: ["organization", input.source.kind],
    };
  }
  return {
    allowed: winning.decision === "allow",
    reason: winning.decision === "allow" ? "matched_allow" : "matched_deny",
    matchedRuleId: winning.id,
    policyVersion: winning.version,
    evaluatedConstraints: evaluatedConstraints(winning),
  };
}
