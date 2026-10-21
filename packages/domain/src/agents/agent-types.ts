import type { ActorRef } from "../shared/authorization.js";

export const agentScopes = [
  "org:read",
  "project:read",
  "request:create",
  "request:read",
  "request:write",
  "request:triage",
  "request:complete",
  "request:verify",
  "question:answer",
  "work:claim",
  "work:update",
  "agent:register",
  "webhook:manage",
  "import:write",
  /**
   * Create projects in the organization, and provision their first agent.
   *
   * Unlike every other scope here, this one is organization-wide rather than
   * project-scoped, and it is exclusive: a grant carrying it may carry no other
   * scope. That is what lets it exist without a project — a grant holding only
   * this registers no project-scoped tool, so it never reaches a command that
   * would need one — and it is also what contains it, since minting authority
   * that could also read requests would simply be a working credential with a
   * bonus.
   */
  "project:provision",
] as const;

export type AgentScope = (typeof agentScopes)[number];

export type AgentPrincipalRecord = {
  id: string;
  organizationId: string;
  projectId: string | null;
  displayName: string;
  slug: string;
  softwareName: string | null;
  status: "active" | "suspended" | "revoked";
  version: number;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type AgentInstallationRecord = {
  id: string;
  organizationId: string;
  agentPrincipalId: string;
  oauthGrantId: string | null;
  credentialId: string | null;
  softwareName: string;
  softwareVersion: string;
  capabilities: Record<string, boolean>;
  status: "active" | "inactive" | "revoked";
  firstSeenAt: Date;
  lastSeenAt: Date;
};

export interface AgentRepository {
  canManage(input: {
    organizationId: string;
    projectId: string | null;
    actor: ActorRef;
  }): Promise<boolean>;
  createPrincipal(input: {
    id: string;
    organizationId: string;
    projectId: string | null;
    displayName: string;
    slug: string;
    softwareName: string | null;
    createdByUserId: string;
  }): Promise<AgentPrincipalRecord>;
  findPrincipal(
    organizationId: string,
    agentPrincipalId: string,
  ): Promise<AgentPrincipalRecord | null>;
  setPrincipalStatus(input: {
    organizationId: string;
    agentPrincipalId: string;
    expectedVersion: number;
    status: "active" | "suspended" | "revoked";
    /**
     * Who acts, which the audit row records through `auditActor`: a person as
     * `user` and their id, an operator as `service` and `operator:<lineage>`
     * (Plan 13, F.3, F3-2), never as its member.
     */
    actor: ActorRef;
    correlationId: string;
    reason: string;
  }): Promise<{
    principal: AgentPrincipalRecord;
    previousStatus: AgentPrincipalRecord["status"];
  }>;
  registerInstallation(input: {
    id: string;
    organizationId: string;
    agentPrincipalId: string;
    authorizationId: string;
    delegatedByUserId?: string | null;
    projectId: string;
    softwareName: string;
    softwareVersion: string;
    capabilities: Record<string, boolean>;
  }): Promise<AgentInstallationRecord>;
}
