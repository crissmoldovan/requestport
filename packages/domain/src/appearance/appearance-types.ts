import { z } from "zod";

/**
 * The locked appearance vocabulary. `packages/db/src/schema/appearance.ts`
 * declares the same literals as the database check constraints and
 * `packages/db/src/schema/appearance.test.ts` asserts the two stay equal, so
 * neither side may widen a vocabulary on its own.
 */
export const appearanceThemes = [
  "requestport",
  "cue",
  "terminal",
  "signal",
  "venu",
  "hivehub",
  "dusk",
  "luma",
  "snuffle",
] as const;
export const appearanceDensities = [
  "ultra-compact",
  "normal",
  "large",
] as const;
export const appearanceModes = ["system", "dark", "light"] as const;
export const appearanceAxes = ["theme", "density", "mode"] as const;

export type AppearanceTheme = (typeof appearanceThemes)[number];
export type AppearanceDensity = (typeof appearanceDensities)[number];
export type AppearanceMode = (typeof appearanceModes)[number];
export type AppearanceAxis = (typeof appearanceAxes)[number];
export type AppearanceSource = "user" | "organization" | "fallback";

export type AppearanceOverrides = {
  theme: AppearanceTheme | null;
  density: AppearanceDensity | null;
  mode: AppearanceMode | null;
};
export type AppearanceDefaults = {
  theme: AppearanceTheme;
  density: AppearanceDensity;
  mode: AppearanceMode;
};
export type AppearanceSnapshot = {
  user: AppearanceOverrides & { version: number };
  organization: AppearanceDefaults & { version: number };
  effective: AppearanceDefaults & {
    source: Record<AppearanceAxis, AppearanceSource>;
  };
};

/** The fixed RequestPort presentation used whenever no stored axis applies. */
export const appearanceFallback: AppearanceDefaults = {
  theme: "requestport",
  density: "ultra-compact",
  mode: "system",
};

export const appearanceThemeSchema = z.enum(appearanceThemes);
export const appearanceDensitySchema = z.enum(appearanceDensities);
export const appearanceModeSchema = z.enum(appearanceModes);

/** Personal axes are nullable: `null` means "inherit". */
export const appearanceOverridesSchema = z.strictObject({
  theme: appearanceThemeSchema.nullable(),
  density: appearanceDensitySchema.nullable(),
  mode: appearanceModeSchema.nullable(),
});
/** Organization axes are required: the tenant default is never "inherit". */
export const appearanceDefaultsSchema = z.strictObject({
  theme: appearanceThemeSchema,
  density: appearanceDensitySchema,
  mode: appearanceModeSchema,
});

export function isAppearanceTheme(value: unknown): value is AppearanceTheme {
  return (
    typeof value === "string" &&
    (appearanceThemes as readonly string[]).includes(value)
  );
}
export function isAppearanceDensity(
  value: unknown,
): value is AppearanceDensity {
  return (
    typeof value === "string" &&
    (appearanceDensities as readonly string[]).includes(value)
  );
}
export function isAppearanceMode(value: unknown): value is AppearanceMode {
  return (
    typeof value === "string" &&
    (appearanceModes as readonly string[]).includes(value)
  );
}

function axisRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Coerces an untrusted stored/serialized personal row. TypeScript types are not
 * validation: a value that predates a vocabulary change, or a hand-edited row,
 * degrades that one axis to "inherit" rather than failing the whole document.
 */
export function parseAppearanceOverrides(value: unknown): AppearanceOverrides {
  const record = axisRecord(value);
  return {
    theme: isAppearanceTheme(record.theme) ? record.theme : null,
    density: isAppearanceDensity(record.density) ? record.density : null,
    mode: isAppearanceMode(record.mode) ? record.mode : null,
  };
}

/** The organization equivalent: a malformed axis degrades to the fallback. */
export function parseAppearanceDefaults(value: unknown): AppearanceDefaults {
  const record = axisRecord(value);
  return {
    theme: isAppearanceTheme(record.theme)
      ? record.theme
      : appearanceFallback.theme,
    density: isAppearanceDensity(record.density)
      ? record.density
      : appearanceFallback.density,
    mode: isAppearanceMode(record.mode) ? record.mode : appearanceFallback.mode,
  };
}

/** Stored versions are positive integers; anything else reads as "absent". */
export function parseAppearanceVersion(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    Number.isSafeInteger(value)
    ? value
    : 0;
}
