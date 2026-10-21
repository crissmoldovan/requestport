import type { RequestRecord } from "../requests/request-types.js";
import type { ActorRef } from "../shared/authorization.js";

export const workSessionStates = [
  "claimed",
  "active",
  "paused",
  "blocked",
  "stale",
  "abandoned",
  "ended",
] as const;
export type WorkSessionState = (typeof workSessionStates)[number];

export type WorkSessionRecord = {
  id: string;
  organizationId: string;
  requestId: string;
  agentPrincipalId: string;
  installationId: string | null;
  workspaceId: string | null;
  authorizationChain: Record<string, unknown>;
  credentialFingerprint: string;
  claimMode: "exclusive";
  state: WorkSessionState;
  version: number;
  eventVersion: number;
  heartbeatIntervalSeconds: number;
  leaseMultiplier: number;
  graceSeconds: number;
  leaseExpiresAt: Date;
  graceExpiresAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  endedReason: string | null;
  outcomeSummaryMd: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export interface WorkRepository {
  currentTime(): Promise<Date>;
  projectLeasePolicy(input: {
    organizationId: string;
    projectId: string;
  }): Promise<{
    heartbeatIntervalSeconds: number;
    leaseMultiplier: number;
    graceSeconds: number;
  } | null>;
  validateAgentBinding(input: {
    organizationId: string;
    request: RequestRecord;
    agentPrincipalId: string;
    authorizationId: string;
    delegatedByUserId?: string | null;
    installationId: string;
    workspaceId: string;
  }): Promise<boolean>;
  validateSessionAuthorization(input: {
    organizationId: string;
    workSessionId: string;
    agentPrincipalId: string;
    authorizationId: string;
    delegatedByUserId?: string | null;
    projectId: string;
  }): Promise<boolean>;
  createClaim(input: {
    id: string;
    organizationId: string;
    requestId: string;
    agentPrincipalId: string;
    installationId: string;
    workspaceId: string;
    authorizationChain: Record<string, unknown>;
    credentialFingerprint: string;
    heartbeatIntervalSeconds: number;
    leaseMultiplier: number;
    graceSeconds: number;
    leaseExpiresAt: Date;
    graceExpiresAt: Date;
  }): Promise<WorkSessionRecord>;
  findForUpdate(
    organizationId: string,
    workSessionId: string,
  ): Promise<WorkSessionRecord | null>;
  transition(input: {
    organizationId: string;
    workSessionId: string;
    expectedVersion: number;
    fromState: WorkSessionState;
    toState: WorkSessionState;
    leaseExpiresAt?: Date;
    graceExpiresAt?: Date;
    startedAt?: Date;
    endedAt?: Date;
    endedReason?: string;
    outcomeSummaryMd?: string;
  }): Promise<WorkSessionRecord>;
  heartbeat(input: {
    organizationId: string;
    workSessionId: string;
    expectedVersion: number;
    state: "active" | "paused" | "blocked";
    leaseExpiresAt: Date;
    graceExpiresAt: Date;
  }): Promise<WorkSessionRecord>;
  appendUpdate(input: {
    id: string;
    session: WorkSessionRecord;
    actor: ActorRef;
    kind: "progress" | "checkpoint" | "blocker" | "note";
    bodyMd: string;
    progressPercent: number | null;
    evidence: Array<Record<string, unknown>>;
  }): Promise<void>;
}
