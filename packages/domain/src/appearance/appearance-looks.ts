import type {
  AppearanceConcreteLook,
  AppearanceConcretePaint,
  AppearanceFont,
  AppearanceLook,
  AppearancePaint,
  AppearanceTheme,
} from "./appearance-types.js";
import { appearanceMatchValue } from "./appearance-types.js";

/**
 * A cue-ui Look: one theme paired with a typeface, a style set and a paint.
 * `font` is cue-ui's whole `FontName`, wider than the typefaces RequestPort
 * offers, because the registry is copied as it is; `appearanceThemeLook` only
 * ever returns an offered one (its test holds that).
 */
export type AppearanceLookEntry = Readonly<{
  id: string;
  theme: string;
  font: string;
  look: AppearanceConcreteLook;
  paint: AppearanceConcretePaint;
}>;

/**
 * cue-ui's Looks registry, copied from `apps/docs/lib/looks.ts` at the tag
 * `@cueplusplus/ui@0.29.0` (commit aeeab5702bfcb7751ed2b2e0ca93ab227b0511c8),
 * in its `LOOKS` order, keeping each Look's theme, font, styleSet (here `look`)
 * and paint and nothing else. The registry lives in cue-ui's docs app and the
 * package does not export it, so RequestPort keeps this copy until it does.
 */
export const appearanceLookRegistry: readonly AppearanceLookEntry[] = [
  {
    id: "classic",
    theme: "cue",
    font: "geist",
    look: "console",
    paint: "none",
  },
  {
    id: "graphite",
    theme: "graphite",
    font: "geist-mono",
    look: "graphite",
    paint: "bevel",
  },
  {
    id: "tender",
    theme: "tender",
    font: "inter-source",
    look: "tender",
    paint: "plume",
  },
  { id: "zine", theme: "zine", font: "dm", look: "zine", paint: "grain" },
  { id: "kiln", theme: "kiln", font: "inter", look: "kiln", paint: "matte" },
  {
    id: "porcelain",
    theme: "porcelain",
    font: "calsans",
    look: "porcelain",
    paint: "glaze",
  },
  {
    id: "ledger",
    theme: "ledger",
    font: "inter",
    look: "ledger",
    paint: "lift",
  },
  {
    id: "command",
    theme: "command",
    font: "fraunces-mono",
    look: "command",
    paint: "grain",
  },
  {
    id: "monolith",
    theme: "monolith",
    font: "geist-mono",
    look: "monolith",
    paint: "none",
  },
  { id: "prism", theme: "prism", font: "inter", look: "prism", paint: "lift" },
  {
    id: "cue-site",
    theme: "monolith",
    font: "jetbrains-mono",
    look: "monolith",
    paint: "none",
  },
];

/** The three values a Look gives the axes left on `match`. */
export type AppearanceLookValues = {
  font: Exclude<AppearanceFont, typeof appearanceMatchValue>;
  look: Exclude<AppearanceLook, typeof appearanceMatchValue>;
  paint: Exclude<AppearancePaint, typeof appearanceMatchValue>;
};

/** cue-ui's `classic` Look, which every theme without a Look of its own follows. */
export const appearanceClassicLook: AppearanceLookValues = {
  font: "geist",
  look: "console",
  paint: "none",
};

/**
 * The Look a theme's `match` follows: the first registry entry built on that
 * theme (monolith has two, and the first listed is `monolith`), or classic.
 */
export function appearanceThemeLook(
  theme: AppearanceTheme,
): AppearanceLookValues {
  const entry = appearanceLookRegistry.find((look) => look.theme === theme);
  return entry
    ? ({
        font: entry.font,
        look: entry.look,
        paint: entry.paint,
      } as AppearanceLookValues)
    : appearanceClassicLook;
}

/**
 * The concrete typeface, Look and surface a ThemeProvider is given: each axis
 * left on `match` takes the theme's Look's value, and an explicit choice is
 * kept as it is.
 */
export function resolveAppearanceLook(input: {
  theme: AppearanceTheme;
  font: AppearanceFont;
  look: AppearanceLook;
  paint: AppearancePaint;
}): AppearanceLookValues {
  const themeLook = appearanceThemeLook(input.theme);
  return {
    font: input.font === appearanceMatchValue ? themeLook.font : input.font,
    look: input.look === appearanceMatchValue ? themeLook.look : input.look,
    paint: input.paint === appearanceMatchValue ? themeLook.paint : input.paint,
  };
}
