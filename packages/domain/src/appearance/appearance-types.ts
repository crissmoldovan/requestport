import { z } from "zod";

/**
 * The locked appearance vocabulary. `packages/db/src/schema/appearance.ts`
 * declares the same literals as the database check constraints and
 * `packages/db/src/schema/appearance.test.ts` asserts the two stay equal, so
 * neither side may widen a vocabulary on its own.
 *
 * Six axes (ruling 255): theme, density and mode, and the three a cue-ui Look
 * pairs with a theme — the typeface (`font`), the Look itself (`look`, cue-ui's
 * style set) and the surface (`paint`). Those three also accept the literal
 * `match`, which resolves through the theme's own Look (`appearance-looks.ts`).
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
  "command",
  "graphite",
  "kiln",
  "ledger",
  "monolith",
  "porcelain",
  "prism",
  "quotamate",
  "tender",
  "zine",
] as const;
/**
 * cue-ui 0.29.0's `DENSITIES` but `ultra-large`, in its order (ruling 255).
 */
export const appearanceDensities = [
  "ultra-compact",
  "compact",
  "normal",
  "large",
] as const;
export const appearanceModes = ["system", "dark", "light"] as const;

/** The value that follows the theme's Look on the font, look and paint axes. */
export const appearanceMatchValue = "match";

/**
 * The typefaces RequestPort offers: every pairing a `match` can resolve to
 * (`appearance-looks.ts`), plus geist, inter, plex and system. Each is one of
 * cue-ui's `FONTS`; the web bundles the faces they name, so every one renders
 * from the application's own origin.
 */
export const appearanceConcreteFonts = [
  "geist",
  "geist-mono",
  "inter",
  "inter-source",
  "plex",
  "dm",
  "calsans",
  "fraunces-mono",
  "system",
] as const;
/** cue-ui 0.29.0's `STYLE_SETS`, in its order: the Look axis. */
export const appearanceConcreteLooks = [
  "console",
  "editorial",
  "marketing",
  "graphite",
  "tender",
  "zine",
  "kiln",
  "porcelain",
  "ledger",
  "command",
  "monolith",
  "prism",
] as const;
/** cue-ui 0.29.0's `PAINTS`, in its order: the surface axis. */
export const appearanceConcretePaints = [
  "none",
  "halo",
  "hatch",
  "lift",
  "frost",
  "bevel",
  "grain",
  "plume",
  "matte",
  "glaze",
] as const;

export const appearanceFonts = [
  appearanceMatchValue,
  ...appearanceConcreteFonts,
] as const;
export const appearanceLooks = [
  appearanceMatchValue,
  ...appearanceConcreteLooks,
] as const;
export const appearancePaints = [
  appearanceMatchValue,
  ...appearanceConcretePaints,
] as const;

export const appearanceAxes = [
  "theme",
  "density",
  "mode",
  "font",
  "look",
  "paint",
] as const;

export type AppearanceTheme = (typeof appearanceThemes)[number];
export type AppearanceDensity = (typeof appearanceDensities)[number];
export type AppearanceMode = (typeof appearanceModes)[number];
export type AppearanceFont = (typeof appearanceFonts)[number];
export type AppearanceLook = (typeof appearanceLooks)[number];
export type AppearancePaint = (typeof appearancePaints)[number];
export type AppearanceConcreteFont = (typeof appearanceConcreteFonts)[number];
export type AppearanceConcreteLook = (typeof appearanceConcreteLooks)[number];
export type AppearanceConcretePaint = (typeof appearanceConcretePaints)[number];
export type AppearanceAxis = (typeof appearanceAxes)[number];
export type AppearanceSource = "user" | "organization" | "fallback";

export type AppearanceOverrides = {
  theme: AppearanceTheme | null;
  density: AppearanceDensity | null;
  mode: AppearanceMode | null;
  font: AppearanceFont | null;
  look: AppearanceLook | null;
  paint: AppearancePaint | null;
};
export type AppearanceDefaults = {
  theme: AppearanceTheme;
  density: AppearanceDensity;
  mode: AppearanceMode;
  font: AppearanceFont;
  look: AppearanceLook;
  paint: AppearancePaint;
};
export type AppearanceSnapshot = {
  user: AppearanceOverrides & { version: number };
  organization: AppearanceDefaults & { version: number };
  effective: AppearanceDefaults & {
    source: Record<AppearanceAxis, AppearanceSource>;
  };
};

/**
 * What applies whenever no stored axis does, and what migration `0026` seeds a
 * new organization with: the cue theme, the system's mode, normal density, and
 * the typeface, Look and surface of the theme's own Look (ruling 255).
 */
export const appearanceFallback: AppearanceDefaults = {
  theme: "cue",
  density: "normal",
  mode: "system",
  font: appearanceMatchValue,
  look: appearanceMatchValue,
  paint: appearanceMatchValue,
};

export const appearanceThemeSchema = z.enum(appearanceThemes);
export const appearanceDensitySchema = z.enum(appearanceDensities);
export const appearanceModeSchema = z.enum(appearanceModes);
export const appearanceFontSchema = z.enum(appearanceFonts);
export const appearanceLookSchema = z.enum(appearanceLooks);
export const appearancePaintSchema = z.enum(appearancePaints);

/** Personal axes are nullable: `null` means "inherit". */
export const appearanceOverridesSchema = z.strictObject({
  theme: appearanceThemeSchema.nullable(),
  density: appearanceDensitySchema.nullable(),
  mode: appearanceModeSchema.nullable(),
  font: appearanceFontSchema.nullable(),
  look: appearanceLookSchema.nullable(),
  paint: appearancePaintSchema.nullable(),
});
/** Organization axes are required: the tenant default is never "inherit". */
export const appearanceDefaultsSchema = z.strictObject({
  theme: appearanceThemeSchema,
  density: appearanceDensitySchema,
  mode: appearanceModeSchema,
  font: appearanceFontSchema,
  look: appearanceLookSchema,
  paint: appearancePaintSchema,
});

function member<T extends string>(values: readonly T[]) {
  return (value: unknown): value is T =>
    typeof value === "string" && (values as readonly string[]).includes(value);
}

export const isAppearanceTheme = member(appearanceThemes);
export const isAppearanceDensity = member(appearanceDensities);
export const isAppearanceMode = member(appearanceModes);
export const isAppearanceFont = member(appearanceFonts);
export const isAppearanceLook = member(appearanceLooks);
export const isAppearancePaint = member(appearancePaints);

/** Each axis's guard, so a caller can validate one axis by its name. */
export const appearanceAxisGuards: {
  [K in AppearanceAxis]: (value: unknown) => value is AppearanceDefaults[K];
} = {
  theme: isAppearanceTheme,
  density: isAppearanceDensity,
  mode: isAppearanceMode,
  font: isAppearanceFont,
  look: isAppearanceLook,
  paint: isAppearancePaint,
};

/** Each axis's full vocabulary, in the order a picker lists it. */
export const appearanceAxisValues: {
  [K in AppearanceAxis]: readonly AppearanceDefaults[K][];
} = {
  theme: appearanceThemes,
  density: appearanceDensities,
  mode: appearanceModes,
  font: appearanceFonts,
  look: appearanceLooks,
  paint: appearancePaints,
};

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
    font: isAppearanceFont(record.font) ? record.font : null,
    look: isAppearanceLook(record.look) ? record.look : null,
    paint: isAppearancePaint(record.paint) ? record.paint : null,
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
    font: isAppearanceFont(record.font) ? record.font : appearanceFallback.font,
    look: isAppearanceLook(record.look) ? record.look : appearanceFallback.look,
    paint: isAppearancePaint(record.paint)
      ? record.paint
      : appearanceFallback.paint,
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
