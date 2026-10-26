import type {
  AppearanceOrganizationAuthorization,
  AppearancePort,
  AppearanceUserAuthorizationPort,
  OrganizationAppearanceRecord,
  UserAppearanceRecord,
} from "../appearance/appearance-service.js";
import type { AuditRecordInput } from "../audit/audit-repository.js";
import type { DomainEvent } from "../shared/command.js";
import { DomainError } from "../shared/errors.js";
import type { JsonValue } from "../shared/idempotency.js";
import type { TransactionManager, UnitOfWork } from "../shared/unit-of-work.js";

type ReceiptRow = {
  normalizedInputHash: string;
  aggregateId?: string;
  result: JsonValue;
  expiresAt: number;
};

export type AppearanceOrganizationSeed = {
  id: string;
  status?: "active" | "suspended" | "archived";
  theme?: string;
  density?: string;
  mode?: string;
  font?: string;
  look?: string;
  paint?: string;
  version?: number;
  aggregateId?: string;
  lastUpdatedByUserId?: string | null;
  /** Omit to seed a stage-one bootstrap organization with no default row. */
  defaults?: boolean;
};

export type AppearanceMembershipSeed = {
  organizationId: string;
  userId: string;
  role?: "owner" | "admin" | "member";
  status?: "active" | "revoked";
};

export type AppearanceEnvironmentSeed = {
  users?: UserAppearanceRecord[];
  organizations?: AppearanceOrganizationSeed[];
  memberships?: AppearanceMembershipSeed[];
  /** Session/user credentials the personal bus accepts as still current. */
  activeSessions?: Array<{ userId: string; credentialId: string }>;
};

type EnvironmentState = {
  users: UserAppearanceRecord[];
  organizations: Array<{ id: string; status: string }>;
  memberships: Array<{
    id: string;
    organizationId: string;
    userId: string;
    role: string;
    status: string;
  }>;
  defaults: OrganizationAppearanceRecord[];
  audits: AuditRecordInput[];
  events: DomainEvent[];
  outbox: string[];
  receipts: Array<{ key: string; row: ReceiptRow }>;
};

/** Every point the command may fail at, so rollback can be proven at each. */
export type AppearanceFailurePoint =
  | "lockUserPreferences"
  | "createUserPreferences"
  | "updateUserPreferences"
  | "lockOrganizationDefaults"
  | "updateOrganizationDefaults"
  | "appendAuditRecord"
  | "events.append"
  | "receipts.save";

export class InMemoryAppearanceEnvironment {
  private state: EnvironmentState;
  readonly locks: string[] = [];
  failOn: AppearanceFailurePoint | null = null;
  revokedSessions = new Set<string>();

  constructor(seed: AppearanceEnvironmentSeed = {}) {
    this.state = {
      users: (seed.users ?? []).map((row) => ({ ...row })),
      organizations: (seed.organizations ?? []).map((organization) => ({
        id: organization.id,
        status: organization.status ?? "active",
      })),
      memberships: (seed.memberships ?? []).map((membership, index) => ({
        id: `membership-${index + 1}`,
        organizationId: membership.organizationId,
        userId: membership.userId,
        role: membership.role ?? "owner",
        status: membership.status ?? "active",
      })),
      defaults: (seed.organizations ?? [])
        .filter((organization) => organization.defaults !== false)
        .map((organization) => ({
          organizationId: organization.id,
          aggregateId:
            organization.aggregateId ?? `aggregate-${organization.id}`,
          theme: (organization.theme ?? "requestport") as never,
          density: (organization.density ?? "ultra-compact") as never,
          mode: (organization.mode ?? "system") as never,
          font: (organization.font ?? "match") as never,
          look: (organization.look ?? "match") as never,
          paint: (organization.paint ?? "match") as never,
          lastUpdatedByUserId: organization.lastUpdatedByUserId ?? null,
          version: organization.version ?? 1,
        })),
      audits: [],
      events: [],
      outbox: [],
      receipts: [],
    };
    this.activeSessions = new Map(
      (seed.activeSessions ?? []).map((entry) => [
        entry.credentialId,
        entry.userId,
      ]),
    );
  }

  private activeSessions: Map<string, string>;

  private snapshot(): EnvironmentState {
    return structuredClone(this.state);
  }

  private fail(point: AppearanceFailurePoint) {
    if (this.failOn === point) {
      throw new Error(`fixed appearance failure: ${point}`);
    }
  }

  get audits() {
    return this.state.audits;
  }
  get events() {
    return this.state.events;
  }
  get outbox() {
    return this.state.outbox;
  }
  get receipts() {
    return this.state.receipts;
  }
  userRow(userId: string) {
    return this.state.users.find((row) => row.userId === userId) ?? null;
  }
  organizationRow(organizationId: string) {
    return (
      this.state.defaults.find(
        (row) => row.organizationId === organizationId,
      ) ?? null
    );
  }
  revokeSession(credentialId: string) {
    this.revokedSessions.add(credentialId);
  }
  suspendOrganization(organizationId: string) {
    for (const organization of this.state.organizations) {
      if (organization.id === organizationId) organization.status = "suspended";
    }
  }
  revokeMembership(organizationId: string, userId: string) {
    for (const membership of this.state.memberships) {
      if (
        membership.organizationId === organizationId &&
        membership.userId === userId
      ) {
        membership.status = "revoked";
      }
    }
  }

  readonly userAuthorization: AppearanceUserAuthorizationPort = {
    assertCurrentUser: async (context) => {
      this.locks.push(`session:${context.credentialId}`);
      const userId = this.activeSessions.get(context.credentialId);
      if (
        this.revokedSessions.has(context.credentialId) ||
        userId === undefined
      ) {
        throw new DomainError(
          "forbidden",
          "Current human authorization is no longer active",
        );
      }
      if (userId !== context.actor.id) {
        throw new DomainError(
          "forbidden",
          "Current human authorization is no longer active",
        );
      }
    },
  };

  private readonly port: AppearancePort = {
    lockUserPreferences: async (userId) => {
      this.fail("lockUserPreferences");
      this.locks.push(`user-appearance:${userId}`);
      const row = this.userRow(userId);
      return row ? { ...row } : null;
    },
    createUserPreferences: async (input) => {
      this.fail("createUserPreferences");
      if (this.userRow(input.userId)) return null;
      const row: UserAppearanceRecord = {
        userId: input.userId,
        aggregateId: `user-aggregate-${input.userId}`,
        theme: input.theme as never,
        density: input.density as never,
        mode: input.mode as never,
        font: input.font as never,
        look: input.look as never,
        paint: input.paint as never,
        version: 1,
      };
      this.state.users.push(row);
      return { ...row };
    },
    updateUserPreferences: async (input) => {
      this.fail("updateUserPreferences");
      const row = this.state.users.find(
        (candidate) => candidate.userId === input.userId,
      );
      if (!row || row.version !== input.expectedVersion) return null;
      row.theme = input.theme as never;
      row.density = input.density as never;
      row.mode = input.mode as never;
      row.font = input.font as never;
      row.look = input.look as never;
      row.paint = input.paint as never;
      row.version += 1;
      return { ...row };
    },
    lockOrganizationAuthorization: async (
      input,
    ): Promise<AppearanceOrganizationAuthorization> => {
      this.locks.push(`organization:${input.organizationId}`);
      const organization =
        this.state.organizations.find(
          (candidate) => candidate.id === input.organizationId,
        ) ?? null;
      this.locks.push(`membership:${input.organizationId}:${input.userId}`);
      const membership =
        this.state.memberships.find(
          (candidate) =>
            candidate.organizationId === input.organizationId &&
            candidate.userId === input.userId,
        ) ?? null;
      return {
        organization: organization ? { ...organization } : null,
        membership: membership ? { ...membership } : null,
      };
    },
    lockOrganizationDefaults: async (organizationId) => {
      this.fail("lockOrganizationDefaults");
      this.locks.push(`organization-appearance:${organizationId}`);
      const row = this.organizationRow(organizationId);
      return row ? { ...row } : null;
    },
    updateOrganizationDefaults: async (input) => {
      this.fail("updateOrganizationDefaults");
      const row = this.state.defaults.find(
        (candidate) => candidate.organizationId === input.organizationId,
      );
      if (!row || row.version !== input.expectedVersion) return null;
      row.theme = input.theme as never;
      row.density = input.density as never;
      row.mode = input.mode as never;
      row.font = input.font as never;
      row.look = input.look as never;
      row.paint = input.paint as never;
      row.lastUpdatedByUserId = input.lastUpdatedByUserId;
      row.version += 1;
      return { ...row };
    },
    appendAuditRecord: async (input) => {
      this.fail("appendAuditRecord");
      this.state.audits.push(structuredClone(input));
    },
  };

  private unitOfWork(): UnitOfWork {
    return {
      commandReceipts: {
        lock: async (key) => {
          this.locks.push(
            `receipt:${key.actorFingerprint}:${key.commandName}:${key.idempotencyFingerprint}`,
          );
        },
        find: async (key) => {
          const stored = this.state.receipts.find(
            (entry) => entry.key === receiptKey(key),
          );
          if (!stored || stored.row.expiresAt <= Date.now()) return null;
          return {
            normalizedInputHash: stored.row.normalizedInputHash,
            aggregateId: stored.row.aggregateId,
            result: stored.row.result,
          };
        },
        save: async (input) => {
          this.fail("receipts.save");
          this.state.receipts.push({
            key: receiptKey(input),
            row: {
              normalizedInputHash: input.normalizedInputHash,
              aggregateId: input.aggregateId,
              result: input.result,
              expiresAt: input.expiresAt.getTime(),
            },
          });
        },
      },
      domainEvents: {
        append: async (events) => {
          if (events.length === 0) return;
          this.fail("events.append");
          for (const event of events) {
            this.state.events.push(structuredClone(event));
            this.state.outbox.push(event.id);
          }
        },
      },
      port: <T>(name: string) => {
        if (name === "appearance") return this.port as T;
        if (name === "commandAuthorization") {
          return this.userAuthorization as T;
        }
        throw new Error(`RequestPort command port is unavailable: ${name}`);
      },
    };
  }

  /** Rolls the whole in-memory state back when the unit of work throws. */
  readonly transactions: TransactionManager = {
    run: async <T>(work: (uow: UnitOfWork) => Promise<T>) => {
      const restore = this.snapshot();
      try {
        return await work(this.unitOfWork());
      } catch (error) {
        this.state = restore;
        throw error;
      }
    },
  };
}

function receiptKey(key: {
  actorFingerprint: string;
  commandName: string;
  idempotencyFingerprint: string;
}) {
  return `${key.actorFingerprint}|${key.commandName}|${key.idempotencyFingerprint}`;
}
