import {
  type AppearanceSnapshot,
  parseAppearanceDefaults,
  parseAppearanceOverrides,
  parseAppearanceVersion,
  resolveAppearanceSnapshot,
} from "@requestport/domain";
import { unstable_rethrow } from "next/navigation";

/**
 * The two relations migration `0014` introduces. Every environment runs the new
 * application code before the migration lands, so a read against a database
 * that has not cut over is an expected transient state — but only for these two
 * names. A missing `organizations` table is a real outage and must never be
 * laundered through the appearance fallback.
 */
export const appearanceRelations = [
  "user_appearance_preferences",
  "organization_appearance_defaults",
] as const;

/** PostgreSQL `undefined_table`. */
const undefinedTableCode = "42P01";

/**
 * Drizzle wraps a driver error in a generic `Failed query: …` Error and hangs
 * the PostgreSQL error off `cause`, so the SQLSTATE is one level down. The walk
 * is bounded so a cyclic or absurdly nested chain cannot spin.
 */
const causeDepthLimit = 5;

type DriverError = { code?: unknown; message?: unknown; cause?: unknown };

function driverError(error: unknown): DriverError | undefined {
  let current = error;
  for (let depth = 0; depth < causeDepthLimit; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const candidate = current as DriverError;
    if (typeof candidate.code === "string") return candidate;
    current = candidate.cause;
  }
  return undefined;
}

/**
 * Whole-identifier match only: `organization_appearance_defaults_pkey` is a
 * different object from `organization_appearance_defaults`, and a constraint
 * name must never be read as a missing table.
 */
function mentionsAppearanceRelation(message: unknown): boolean {
  if (typeof message !== "string") return false;
  return appearanceRelations.some((relation) =>
    new RegExp(`(^|[^0-9a-z_])${relation}([^0-9a-z_]|$)`, "u").test(message),
  );
}

/** Exactly the pre-`0014` rollout condition, and nothing that merely resembles it. */
export function isPendingAppearanceSchemaError(error: unknown): boolean {
  const candidate = driverError(error);
  return (
    candidate?.code === undefinedTableCode &&
    mentionsAppearanceRelation(candidate.message)
  );
}

export type AppearanceWriteFailureCode =
  | "temporarily_unavailable"
  | "unexpected_error";

/**
 * Appearance writes map only the exact missing-schema condition to
 * `temporarily_unavailable`; every other unknown failure stays
 * `unexpected_error` so a real defect cannot hide behind a rollout message.
 */
export function appearanceWriteFailureCode(
  error: unknown,
): AppearanceWriteFailureCode {
  return isPendingAppearanceSchemaError(error)
    ? "temporarily_unavailable"
    : "unexpected_error";
}

export const appearanceSchemaPendingEvent = "appearance.schema_pending";
export const appearanceResolutionFailedEvent = "appearance.resolution_failed";
/** The rollout condition is expected and self-clearing, so its telemetry is bounded. */
export const appearanceSchemaPendingLogLimit = 5;
const appearanceResolutionErrorCode = "appearance_unavailable";

export type AppearanceDiagnosticLogger = {
  warn: (event: string, fields: { errorCode?: string; count?: number }) => void;
};

export type AppearanceDiagnostics = {
  recordResolutionFailure: (error: unknown) => void;
};

/**
 * Fixed, value-free diagnostics. Nothing derived from the thrown error — no
 * message, query, connection string, or provider payload — reaches the log.
 */
export function createAppearanceDiagnostics(input: {
  logger: AppearanceDiagnosticLogger;
  schemaPendingLimit?: number;
}): AppearanceDiagnostics {
  const limit = input.schemaPendingLimit ?? appearanceSchemaPendingLogLimit;
  let schemaPending = 0;

  return {
    recordResolutionFailure(error) {
      if (isPendingAppearanceSchemaError(error)) {
        schemaPending += 1;
        if (schemaPending > limit) return;
        input.logger.warn(appearanceSchemaPendingEvent, {
          count: schemaPending,
          errorCode: undefinedTableCode,
        });
        return;
      }
      input.logger.warn(appearanceResolutionFailedEvent, {
        errorCode: appearanceResolutionErrorCode,
      });
    },
  };
}

/** The fixed RequestPort presentation every fail-open path emits. */
export function fallbackAppearanceSnapshot(): AppearanceSnapshot {
  return resolveAppearanceSnapshot({ user: null, organization: null });
}

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Re-derives the effective axes from the two stored rows instead of trusting
 * a projection. A row written by a newer writer, or edited by hand, degrades
 * exactly the axis it broke; a non-positive version reads as an absent row.
 */
export function sanitizeAppearanceSnapshot(value: unknown): AppearanceSnapshot {
  const record = objectOf(value);
  const userRow = objectOf(record.user);
  const organizationRow = objectOf(record.organization);
  const userVersion = parseAppearanceVersion(userRow.version);
  const organizationVersion = parseAppearanceVersion(organizationRow.version);

  return resolveAppearanceSnapshot({
    user:
      userVersion > 0
        ? { ...parseAppearanceOverrides(userRow), version: userVersion }
        : null,
    organization:
      organizationVersion > 0
        ? {
            ...parseAppearanceDefaults(organizationRow),
            version: organizationVersion,
          }
        : null,
  });
}

export type AppearanceResolutionStatus =
  | "anonymous"
  | "authenticated"
  | "unavailable";

export type AppearanceResolution = {
  snapshot: AppearanceSnapshot;
  status: AppearanceResolutionStatus;
};

export type AppearanceSnapshotDependencies = {
  diagnostics: AppearanceDiagnostics;
  readOptionalUserId: () => Promise<string | null>;
  readCurrentOrganizationId: (userId: string) => Promise<string | null>;
  readSnapshot: (input: {
    userId: string;
    organizationId: string | null;
  }) => Promise<unknown>;
};

/**
 * The presentation boundary. It is deliberately fail-open: an optional-session,
 * cookie, database, provider, or preference-read failure emits the fixed
 * fallback axes plus one safe diagnostic and returns. It never substitutes
 * a session, never reports one it did not read, and never decides anything the
 * page's own authentication and product-data boundaries own.
 */
export async function loadAppearanceSnapshot(
  dependencies: AppearanceSnapshotDependencies,
): Promise<AppearanceResolution> {
  try {
    const userId = await dependencies.readOptionalUserId();
    if (userId === null) {
      return { snapshot: fallbackAppearanceSnapshot(), status: "anonymous" };
    }

    const organizationId = await dependencies.readCurrentOrganizationId(userId);
    const stored = await dependencies.readSnapshot({ userId, organizationId });

    return {
      snapshot: sanitizeAppearanceSnapshot(stored),
      status: "authenticated",
    };
  } catch (error) {
    // Fail-open is about *failures*. `redirect()` and `notFound()` are the
    // framework's control flow, implemented by throwing, and mapping one to the
    // fixed fallback would leave the reader on a page Next had already decided to
    // leave — and record a diagnostic about a navigation. The dependencies here
    // are injected, so no rule read off this module's text can tell whether one
    // of them redirects; handing the sentinel back costs nothing when none does.
    unstable_rethrow(error);
    dependencies.diagnostics.recordResolutionFailure(error);
    return { snapshot: fallbackAppearanceSnapshot(), status: "unavailable" };
  }
}
