export const requestTypes = [
  "feature",
  "bug",
  "question",
  "chore",
  "investigation",
] as const;
export type RequestType = (typeof requestTypes)[number];

export const requestPriorities = ["urgent", "high", "normal", "low"] as const;
export type RequestPriority = (typeof requestPriorities)[number];

export type RouteSource =
  | { kind: "human_direct" }
  | { kind: "project"; projectId: string };

export type RoutingPrincipal =
  | {
      type: "user";
      id: string;
      organizationRole: "owner" | "admin" | "member";
      scopes: ReadonlySet<string>;
    }
  | {
      type: "agent";
      id: string;
      scopes: ReadonlySet<string>;
    };

export interface RoutingRule {
  id: string;
  organizationId: string;
  sourceKind: RouteSource["kind"];
  sourceProjectId?: string;
  targetProjectId: string;
  decision: "allow" | "deny";
  requestTypes: readonly RequestType[];
  laneIds: readonly string[];
  priorities: readonly RequestPriority[];
  humanRoles: ReadonlyArray<"owner" | "admin" | "member">;
  agentPrincipalIds: readonly string[];
  specificity: number;
  enabled: boolean;
  version: number;
}

export interface RouteEvaluationInput {
  sourceOrganizationId: string;
  targetOrganizationId: string;
  source: RouteSource;
  targetProjectId: string;
  laneId?: string;
  requestType: RequestType;
  priority: RequestPriority;
  principal: RoutingPrincipal;
}

export type RouteDecision = {
  allowed: boolean;
  reason:
    | "default_same_org"
    | "matched_allow"
    | "matched_deny"
    | "cross_org_denied"
    | "no_matching_permission";
  matchedRuleId?: string;
  policyVersion: number;
  evaluatedConstraints: string[];
};
