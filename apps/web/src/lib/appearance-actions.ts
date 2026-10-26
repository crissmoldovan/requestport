import {
  type AppearanceDefaults,
  type AppearanceOverrides,
  appearanceDensitySchema,
  appearanceFontSchema,
  appearanceLookSchema,
  appearanceModeSchema,
  appearancePaintSchema,
  appearanceThemeSchema,
  DomainError,
  type DomainErrorCode,
  utf16Max,
  utf16Min,
} from "@requestport/domain";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";

import {
  type AppearanceActionState,
  type AppearanceFieldName,
  type AppearanceGlobalErrorCode,
  appearanceActionMessages,
  appearanceDefaultDestination,
  appearanceFieldNames,
  appearanceInheritValue,
} from "../app/(app)/settings/appearance/action-state.js";
import { appearanceWriteFailureCode } from "./appearance.js";
import type { AppearanceFormContextClaims } from "./appearance-form-context.js";

/**
 * The appearance actions, with every effect behind an injected port.
 *
 * Nothing here reads a user or organization identifier from the submitted form:
 * the actor and the current tenant are resolved server-side by `loadActor`, the
 * render-context token is only compared against that fresh context, and the
 * command ports receive the identifiers this module derived rather than the
 * ones the browser sent.
 */

export type AppearanceWriteScope = "personal" | "organization";

export type AppearanceActorContext = {
  organizationId: string | null;
  userId: string;
};

export type AppearanceCommandMeta = {
  expectedVersion: number;
  idempotencyKey: string;
};

/** The three axes ruling 255 added. */
type AddedAxis = "font" | "look" | "paint";

/**
 * What a form write carries: every axis but the three ruling 255 added, which
 * are optional — a page rendered before the change posts theme, density and
 * mode alone, and the command keeps what is stored on an axis left out.
 */
export type AppearanceDefaultsWrite = Omit<AppearanceDefaults, AddedAxis> &
  Partial<Pick<AppearanceDefaults, AddedAxis>>;
export type AppearanceOverridesWrite = Omit<AppearanceOverrides, AddedAxis> &
  Partial<Pick<AppearanceOverrides, AddedAxis>>;

export type AppearanceActionDependencies = {
  enforceRateLimit: (input: {
    scope: AppearanceWriteScope;
    userId: string;
  }) => Promise<void>;
  loadActor: () => Promise<AppearanceActorContext>;
  revalidate: () => void;
  updateOrganizationDefaults: (input: {
    defaults: AppearanceDefaultsWrite;
    meta: AppearanceCommandMeta;
    organizationId: string;
    userId: string;
  }) => Promise<void>;
  updatePersonalPreferences: (input: {
    meta: AppearanceCommandMeta;
    overrides: AppearanceOverridesWrite;
    userId: string;
  }) => Promise<void>;
  verifyFormContext: (input: {
    expected: AppearanceFormContextClaims;
    token: unknown;
  }) => boolean;
};

const inheritSchema = z.literal(appearanceInheritValue);
const metadataSchema = {
  idempotencyKey: z.string().trim().check(utf16Min(16)).check(utf16Max(200)),
  renderContext: z.string().min(1).check(utf16Max(512)),
  returnTo: z.string().check(utf16Max(512)).optional(),
};

/**
 * Personal axes accept `inherit`; the tenant default never does. Today's forms
 * submit all six axes (ruling 255); font, look and paint are optional so a
 * page rendered before that change still saves (`AppearanceDefaultsWrite`).
 */
const personalSchema = z.object({
  ...metadataSchema,
  density: z.union([inheritSchema, appearanceDensitySchema]),
  expectedVersion: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  font: z.union([inheritSchema, appearanceFontSchema]).optional(),
  look: z.union([inheritSchema, appearanceLookSchema]).optional(),
  mode: z.union([inheritSchema, appearanceModeSchema]),
  paint: z.union([inheritSchema, appearancePaintSchema]).optional(),
  theme: z.union([inheritSchema, appearanceThemeSchema]),
});

const organizationSchema = z.object({
  ...metadataSchema,
  density: appearanceDensitySchema,
  font: appearanceFontSchema.optional(),
  look: appearanceLookSchema.optional(),
  paint: appearancePaintSchema.optional(),
  // A persisted tenant default starts at version 1, so `0` is never expected.
  expectedVersion: z.coerce
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER),
  mode: appearanceModeSchema,
  theme: appearanceThemeSchema,
});

/**
 * A same-origin absolute path, and nothing else. Anything with an authority, a
 * scheme, or a backslash falls back to the appearance settings route rather
 * than becoming an open redirect on a successful write.
 */
const destinationPattern = /^\/[\w\-.~!$&'()*+,;=:@%/?]*$/u;

export function validAppearanceDestination(value: unknown): string {
  if (typeof value !== "string") return appearanceDefaultDestination;
  const candidate = value.trim();
  if (
    candidate.length === 0 ||
    candidate.length > 512 ||
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("\\") ||
    !destinationPattern.test(candidate)
  ) {
    return appearanceDefaultDestination;
  }
  return candidate;
}

function globalError(code: AppearanceGlobalErrorCode): AppearanceActionState {
  return {
    code,
    message: appearanceActionMessages[code],
    status: "global_error",
  };
}

const domainErrorCodes: Partial<
  Record<DomainErrorCode, AppearanceGlobalErrorCode>
> = {
  conflict: "not_initialized",
  forbidden: "forbidden",
  idempotency_conflict: "invalid_request",
  not_found: "not_initialized",
  rate_limited: "rate_limited",
  unauthenticated: "forbidden",
  validation_failed: "invalid_request",
};

/**
 * Only allowlisted outcomes are described. Every other failure collapses to the
 * two fixed write codes `lib/appearance.ts` owns, so a driver message, query, or
 * connection string can never reach the browser.
 *
 * Next signals `redirect()`/`notFound()` by throwing, so the framework's own
 * control flow has to leave before anything is mapped: `loadActor` is the
 * application context in production, and it redirects an expired session to
 * `/sign-in`. Mapping that throw would replace the navigation with a permanent
 * "could not be saved" banner.
 */
function mapWriteError(error: unknown): AppearanceActionState {
  unstable_rethrow(error);
  if (error instanceof DomainError) {
    if (error.code === "version_conflict") {
      return {
        message: appearanceActionMessages.version_conflict,
        status: "version_conflict",
      };
    }
    return globalError(domainErrorCodes[error.code] ?? "unexpected_error");
  }
  return globalError(appearanceWriteFailureCode(error));
}

function parseFailure(issues: readonly z.core.$ZodIssue[]) {
  for (const issue of issues) {
    const field = issue.path[0];
    if (
      typeof field === "string" &&
      (appearanceFieldNames as readonly string[]).includes(field)
    ) {
      return {
        field: field as AppearanceFieldName,
        message: appearanceActionMessages.field,
        status: "field_error",
      } satisfies AppearanceActionState;
    }
  }
  return globalError("invalid_request");
}

function axis<T extends string>(value: T | typeof appearanceInheritValue) {
  return value === appearanceInheritValue ? null : (value as T);
}

/** The added axes the form sent, and no key for one it left out. */
function sentAxes<T>(values: Partial<Record<AddedAxis, T>>) {
  return Object.fromEntries(
    (["font", "look", "paint"] as const)
      .filter((name) => values[name] !== undefined)
      .map((name) => [name, values[name]]),
  ) as Partial<Record<AddedAxis, T>>;
}

function contextConflict(): AppearanceActionState {
  return {
    message: appearanceActionMessages.context_conflict,
    status: "context_conflict",
  };
}

export function createAppearanceActions(
  dependencies: AppearanceActionDependencies,
) {
  return {
    async updateOrganizationDefaults(
      formData: FormData,
    ): Promise<AppearanceActionState> {
      try {
        const actor = await dependencies.loadActor();
        await dependencies.enforceRateLimit({
          scope: "organization",
          userId: actor.userId,
        });
        if (actor.organizationId === null) return globalError("forbidden");

        const parsed = organizationSchema.safeParse(
          Object.fromEntries(formData),
        );
        if (!parsed.success) return parseFailure(parsed.error.issues);

        if (
          !dependencies.verifyFormContext({
            expected: {
              actorId: actor.userId,
              organizationId: actor.organizationId,
            },
            token: parsed.data.renderContext,
          })
        ) {
          return contextConflict();
        }

        await dependencies.updateOrganizationDefaults({
          defaults: {
            density: parsed.data.density,
            mode: parsed.data.mode,
            theme: parsed.data.theme,
            ...sentAxes({
              font: parsed.data.font,
              look: parsed.data.look,
              paint: parsed.data.paint,
            }),
          } as AppearanceDefaultsWrite,
          meta: {
            expectedVersion: parsed.data.expectedVersion,
            idempotencyKey: parsed.data.idempotencyKey,
          },
          organizationId: actor.organizationId,
          userId: actor.userId,
        });
        dependencies.revalidate();
        return {
          destination: validAppearanceDestination(parsed.data.returnTo),
          status: "success",
        };
      } catch (error) {
        return mapWriteError(error);
      }
    },

    async updatePersonalPreferences(
      formData: FormData,
    ): Promise<AppearanceActionState> {
      try {
        const actor = await dependencies.loadActor();
        await dependencies.enforceRateLimit({
          scope: "personal",
          userId: actor.userId,
        });

        const parsed = personalSchema.safeParse(Object.fromEntries(formData));
        if (!parsed.success) return parseFailure(parsed.error.issues);

        // Personal preferences follow the user across organizations, so the
        // token binds the actor alone and stays valid after an org switch.
        if (
          !dependencies.verifyFormContext({
            expected: { actorId: actor.userId, organizationId: null },
            token: parsed.data.renderContext,
          })
        ) {
          return contextConflict();
        }

        await dependencies.updatePersonalPreferences({
          meta: {
            expectedVersion: parsed.data.expectedVersion,
            idempotencyKey: parsed.data.idempotencyKey,
          },
          overrides: {
            density: axis(parsed.data.density),
            mode: axis(parsed.data.mode),
            theme: axis(parsed.data.theme),
            ...sentAxes({
              font:
                parsed.data.font === undefined
                  ? undefined
                  : axis(parsed.data.font),
              look:
                parsed.data.look === undefined
                  ? undefined
                  : axis(parsed.data.look),
              paint:
                parsed.data.paint === undefined
                  ? undefined
                  : axis(parsed.data.paint),
            }),
          } as AppearanceOverridesWrite,
          userId: actor.userId,
        });
        dependencies.revalidate();
        return {
          destination: validAppearanceDestination(parsed.data.returnTo),
          status: "success",
        };
      } catch (error) {
        return mapWriteError(error);
      }
    },
  };
}
