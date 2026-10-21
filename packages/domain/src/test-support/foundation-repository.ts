import type {
  AuditRecordInput,
  FoundationRepository,
  FoundationTransaction,
  InvitationRecord,
  MembershipRecord,
  OrganizationRecord,
  ProjectRecord,
  ProjectRepositoryRecord,
} from "../audit/audit-repository.js";
import type { DomainEvent } from "../shared/command.js";
import { DomainError } from "../shared/errors.js";

export type FoundationState = {
  organizations: OrganizationRecord[];
  memberships: MembershipRecord[];
  invitations: InvitationRecord[];
  projects: ProjectRecord[];
  repositories: ProjectRepositoryRecord[];
  audits: AuditRecordInput[];
  events: DomainEvent[];
  users: Array<{ id: string; normalizedEmail: string }>;
  allowlist: Array<{
    normalizedEmail: string;
    status: "active" | "revoked";
    expiresAt: Date | null;
  }>;
};

const initialState = (): FoundationState => ({
  organizations: [],
  memberships: [],
  invitations: [],
  projects: [],
  repositories: [],
  audits: [],
  events: [],
  users: [],
  allowlist: [],
});

function deterministicUuid(sequence: number) {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

export class InMemoryFoundationRepository implements FoundationRepository {
  state: FoundationState;
  failOn: string | undefined;
  readonly now: () => Date;

  constructor({
    state,
    now = () => new Date("2026-08-16T12:00:00.000Z"),
  }: { state?: Partial<FoundationState>; now?: () => Date } = {}) {
    this.state = { ...initialState(), ...structuredClone(state ?? {}) };
    this.now = now;
  }

  async transaction<T>(run: (tx: FoundationTransaction) => Promise<T>) {
    const staged = structuredClone(this.state);
    const tx = new InMemoryFoundationTransaction(staged, this);
    const result = await run(tx);
    this.state = staged;
    return result;
  }
}

class InMemoryFoundationTransaction implements FoundationTransaction {
  constructor(
    private readonly state: FoundationState,
    private readonly owner: InMemoryFoundationRepository,
  ) {}

  private check(operation: string) {
    if (this.owner.failOn === operation) throw new Error(`failed:${operation}`);
  }

  async createOrganization(input: { name: string; slug: string }) {
    this.check("createOrganization");
    if (
      this.state.organizations.some(
        (organization) => organization.slug.toLowerCase() === input.slug,
      )
    ) {
      throw new Error("organization conflict");
    }
    const organization: OrganizationRecord = {
      id: deterministicUuid(this.state.organizations.length + 1),
      name: input.name,
      slug: input.slug,
      status: "active",
    };
    this.state.organizations.push(organization);
    return organization;
  }

  async findOrganizationBySlugForUpdate(slug: string) {
    return (
      this.state.organizations.find(
        (organization) => organization.slug.toLowerCase() === slug,
      ) ?? null
    );
  }

  async lockBootstrapSlug(_slug: string) {
    this.check("lockBootstrapSlug");
  }

  async createOrganizationMembership(input: {
    organizationId: string;
    userId: string;
    role: "owner" | "admin" | "member";
  }) {
    this.check("createOrganizationMembership");
    const membership: MembershipRecord = {
      id: `membership_${this.state.memberships.length + 1}`,
      organizationId: input.organizationId,
      userId: input.userId,
      role: input.role,
      status: "active",
    };
    this.state.memberships.push(membership);
    return membership;
  }

  async findOrganizationAuthorization(organizationId: string, userId: string) {
    const organization =
      this.state.organizations.find(
        (candidate) => candidate.id === organizationId,
      ) ?? null;
    const membership =
      this.state.memberships.find(
        (membership) =>
          membership.organizationId === organizationId &&
          membership.userId === userId,
      ) ?? null;
    return { organization, membership };
  }

  async findActiveOrganizationOwners(organizationId: string) {
    return this.state.memberships.filter(
      (membership) =>
        membership.organizationId === organizationId &&
        membership.role === "owner" &&
        membership.status === "active",
    );
  }

  async activateOwnerMembership(input: {
    organizationId: string;
    userId: string;
  }) {
    this.check("activateOwnerMembership");
    const existing = this.state.memberships.find(
      (membership) =>
        membership.organizationId === input.organizationId &&
        membership.userId === input.userId,
    );
    if (existing) {
      const changed = existing.role !== "owner" || existing.status !== "active";
      existing.role = "owner";
      existing.status = "active";
      return { membership: existing, changed };
    }
    const membership = await this.createOrganizationMembership({
      ...input,
      role: "owner",
    });
    return { membership, changed: true };
  }

  async findUserByNormalizedEmail(normalizedEmail: string) {
    return (
      this.state.users.find(
        (user) => user.normalizedEmail.toLowerCase() === normalizedEmail,
      ) ?? null
    );
  }

  async ensureActiveAllowlist(normalizedEmail: string) {
    this.check("ensureActiveAllowlist");
    const existing = this.state.allowlist.find(
      (entry) => entry.normalizedEmail.toLowerCase() === normalizedEmail,
    );
    if (existing) {
      const changed =
        existing.status !== "active" || existing.expiresAt !== null;
      existing.status = "active";
      existing.expiresAt = null;
      return { changed };
    }
    this.state.allowlist.push({
      normalizedEmail,
      status: "active",
      expiresAt: null,
    });
    return { changed: true };
  }

  async findInvitation(organizationId: string, normalizedEmail: string) {
    const invitation = this.state.invitations.find(
      (candidate) =>
        candidate.organizationId === organizationId &&
        candidate.normalizedEmail.toLowerCase() === normalizedEmail,
    );
    if (!invitation) return null;
    return {
      ...invitation,
      active:
        invitation.acceptedAt === null &&
        invitation.revokedAt === null &&
        invitation.expiresAt > this.owner.now(),
    };
  }

  async lockInvitation(_organizationId: string, _normalizedEmail: string) {
    this.check("lockInvitation");
  }

  async createInvitation(input: {
    organizationId: string;
    normalizedEmail: string;
    role: "owner" | "admin" | "member";
    tokenHash: string;
    expiresInSeconds: number;
    createdByUserId: string;
  }) {
    this.check("createInvitation");
    const invitation: InvitationRecord = {
      id: `invitation_${this.state.invitations.length + 1}`,
      organizationId: input.organizationId,
      normalizedEmail: input.normalizedEmail,
      role: input.role,
      tokenHash: input.tokenHash,
      expiresAt: new Date(
        this.owner.now().getTime() + input.expiresInSeconds * 1_000,
      ),
      acceptedAt: null,
      revokedAt: null,
      expiresInSeconds: input.expiresInSeconds,
      version: 1,
    };
    this.state.invitations.push(invitation);
    return invitation;
  }

  async findActiveMembershipByEmail(
    organizationId: string,
    normalizedEmail: string,
  ) {
    this.check("findActiveMembershipByEmail");
    const person = this.state.users.find(
      (candidate) =>
        candidate.normalizedEmail.toLowerCase() === normalizedEmail,
    );
    if (!person) return null;
    return (
      this.state.memberships.find(
        (membership) =>
          membership.organizationId === organizationId &&
          membership.userId === person.id &&
          membership.status === "active",
      ) ?? null
    );
  }

  async renewInvitation(input: {
    organizationId: string;
    invitationId: string;
    expectedVersion: number;
    role: "owner" | "admin" | "member";
    tokenHash: string;
    expiresInSeconds: number;
    createdByUserId: string;
  }) {
    this.check("renewInvitation");
    const invitation = this.state.invitations.find(
      (candidate) =>
        candidate.organizationId === input.organizationId &&
        candidate.id === input.invitationId,
    );
    const now = this.owner.now();
    if (
      !invitation ||
      invitation.version !== input.expectedVersion ||
      (invitation.acceptedAt === null &&
        invitation.revokedAt === null &&
        invitation.expiresAt > now)
    ) {
      throw new DomainError("version_conflict", "Invitation version changed");
    }
    invitation.role = input.role;
    invitation.tokenHash = input.tokenHash;
    invitation.expiresAt = new Date(
      now.getTime() + input.expiresInSeconds * 1_000,
    );
    invitation.expiresInSeconds = input.expiresInSeconds;
    invitation.acceptedAt = null;
    invitation.revokedAt = null;
    invitation.version += 1;
    return { ...invitation };
  }

  async createProject(input: {
    organizationId: string;
    name: string;
    slug: string;
    keyPrefix: string;
    description: string | null;
  }) {
    this.check("createProject");
    const project: ProjectRecord = {
      id: `project_${this.state.projects.length + 1}`,
      ...input,
      status: "active",
      version: 1,
      heartbeatIntervalSeconds: 30,
      leaseMultiplier: 3,
      graceSeconds: 900,
      requiredWorkspaceFields: [],
    };
    this.state.projects.push(project);
    return project;
  }

  async createProjectRepository(input: {
    organizationId: string;
    projectId: string;
    browseUrl: string;
    cloneUrl: string;
    repositorySlug: string;
  }) {
    this.check("createProjectRepository");
    const repository: ProjectRepositoryRecord = {
      id: `repository_${this.state.repositories.length + 1}`,
      ...input,
      provider: "github",
      isDefault: true,
      status: "active",
    };
    this.state.repositories.push(repository);
    return repository;
  }

  async appendAuditRecord(input: AuditRecordInput) {
    this.check("appendAuditRecord");
    this.state.audits.push(input);
  }

  async appendDomainEvent(event: DomainEvent) {
    this.check("appendDomainEvent");
    this.state.events.push(event);
  }
}
