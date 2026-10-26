import type { OrganizationRole } from "../audit/audit-repository.js";

export type OrganizationAccess = {
  id: string;
  name: string;
  slug: string;
  role: OrganizationRole;
};

export type OrganizationProject = {
  id: string;
  name: string;
  slug: string;
  keyPrefix: string;
  status: "active" | "archived";
  canRepresent: boolean;
  defaultRepository: {
    browseUrl: string;
    repositorySlug: string;
  } | null;
};

export type OrganizationMember = {
  userId: string;
  name: string;
  email: string;
  role: OrganizationRole;
  version: number;
  /** When the membership began: `organization_members.joined_at`. */
  joinedAt: Date;
};

export type OrganizationLane = {
  id: string;
  projectId: string;
  name: string;
  slug: string;
};

export type PendingInvitation = {
  id: string;
  email: string;
  role: OrganizationRole;
  expiresAt: Date;
  version: number;
};

/**
 * Safe read projections for the authenticated human UI. Mutation authority
 * remains in the command services; callers must validate tenant access before
 * using organization-scoped list methods.
 */
export interface FoundationQueryRepository {
  listActiveOrganizationsForUser(userId: string): Promise<OrganizationAccess[]>;
  findActiveOrganizationForUser(
    userId: string,
    organizationId: string,
  ): Promise<OrganizationAccess | null>;
  listOrganizationProjects(
    userId: string,
    organizationId: string,
  ): Promise<OrganizationProject[]>;
  listOrganizationLanes(
    userId: string,
    organizationId: string,
  ): Promise<OrganizationLane[]>;
  listOrganizationMembers(
    userId: string,
    organizationId: string,
  ): Promise<OrganizationMember[]>;
  listPendingInvitations(
    userId: string,
    organizationId: string,
  ): Promise<PendingInvitation[]>;
}
