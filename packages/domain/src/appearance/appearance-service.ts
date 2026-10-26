import type { AuditRecordInput } from "../audit/audit-repository.js";
import {
  type AppearanceAxis,
  type AppearanceDefaults,
  type AppearanceOverrides,
  type AppearanceSnapshot,
  type AppearanceSource,
  appearanceAxes,
  appearanceFallback,
  parseAppearanceDefaults,
  parseAppearanceOverrides,
  parseAppearanceVersion,
} from "./appearance-types.js";

export type StoredUserAppearance = {
  aggregateId?: string;
  version: number;
} & AppearanceOverrides;

export type StoredOrganizationAppearance = {
  aggregateId?: string;
  version: number;
} & AppearanceDefaults;

export type AppearanceSnapshotInput = {
  user: StoredUserAppearance | null | undefined;
  organization: StoredOrganizationAppearance | null | undefined;
};

/**
 * Resolves the six appearance axes independently: personal override wins,
 * then the current organization default, then the fixed fallback. A `match`
 * on the font, look or paint axis is a value here like any other; it becomes a
 * concrete face, style set or paint only in `resolveAppearanceLook`.
 * Stored values are re-parsed here because the database is the source of truth
 * for other deployments too — a row written by a newer or hand-edited writer
 * must degrade one axis, never the whole projection.
 */
export function resolveAppearanceSnapshot(
  input: AppearanceSnapshotInput,
): AppearanceSnapshot {
  const overrides = input.user
    ? parseAppearanceOverrides(input.user)
    : {
        theme: null,
        density: null,
        mode: null,
        font: null,
        look: null,
        paint: null,
      };
  const userVersion = input.user
    ? parseAppearanceVersion(input.user.version)
    : 0;
  const organizationPresent = Boolean(input.organization);
  const defaults = organizationPresent
    ? parseAppearanceDefaults(input.organization)
    : appearanceFallback;
  const organizationVersion = input.organization
    ? parseAppearanceVersion(input.organization.version)
    : 0;

  const source = {} as Record<AppearanceAxis, AppearanceSource>;
  const effective = {} as AppearanceDefaults;
  for (const axis of appearanceAxes) {
    const override = overrides[axis];
    if (override !== null) {
      source[axis] = "user";
      // Assigning per axis keeps the axes independent; a union-typed
      // record assignment would otherwise widen every axis to every value.
      Object.assign(effective, { [axis]: override });
      continue;
    }
    source[axis] = organizationPresent ? "organization" : "fallback";
    Object.assign(effective, { [axis]: defaults[axis] });
  }

  return {
    user: { ...overrides, version: userVersion },
    organization: { ...defaults, version: organizationVersion },
    effective: { ...effective, source },
  };
}

export type UserAppearanceRecord = AppearanceOverrides & {
  userId: string;
  aggregateId: string;
  version: number;
};

export type OrganizationAppearanceRecord = AppearanceDefaults & {
  organizationId: string;
  aggregateId: string;
  lastUpdatedByUserId: string | null;
  version: number;
};

export type AppearanceOrganizationAuthorization = {
  organization: { id: string; status: string } | null;
  membership: { id: string; role: string; status: string } | null;
};

/**
 * The explicit appearance port. Every method runs inside the command
 * transaction so the lock order in `appearance-commands.ts` — receipt, session,
 * organization, membership, preference row — is the one the database sees.
 */
export interface AppearancePort {
  /** Serializes writers for one user, then reads the row FOR UPDATE. */
  lockUserPreferences(userId: string): Promise<UserAppearanceRecord | null>;
  /** Inserts the first personal row; returns `null` when one already exists. */
  createUserPreferences(
    input: { userId: string } & AppearanceOverrides,
  ): Promise<UserAppearanceRecord | null>;
  /** Compare-and-swap; returns `null` when the expected version no longer holds. */
  updateUserPreferences(
    input: { userId: string; expectedVersion: number } & AppearanceOverrides,
  ): Promise<UserAppearanceRecord | null>;
  /** Locks the organization FOR SHARE, then the exact membership FOR SHARE. */
  lockOrganizationAuthorization(input: {
    organizationId: string;
    userId: string;
  }): Promise<AppearanceOrganizationAuthorization>;
  lockOrganizationDefaults(
    organizationId: string,
  ): Promise<OrganizationAppearanceRecord | null>;
  updateOrganizationDefaults(
    input: {
      organizationId: string;
      expectedVersion: number;
      lastUpdatedByUserId: string;
    } & AppearanceDefaults,
  ): Promise<OrganizationAppearanceRecord | null>;
  appendAuditRecord(input: AuditRecordInput): Promise<void>;
}

/** The port name both command buses resolve from the unit of work. */
export const appearancePortName = "appearance";

/**
 * The session-only reauthorization the personal bus performs before any replay.
 * It deliberately knows nothing about organizations: personal appearance is
 * global and must work for a user with no active organization at all.
 */
export interface AppearanceUserAuthorizationPort {
  assertCurrentUser(context: {
    actor: { type: "user"; id: string };
    credentialId: string;
  }): Promise<void>;
}
