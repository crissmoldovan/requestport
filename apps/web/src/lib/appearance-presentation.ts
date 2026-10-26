import {
  type AppearanceConcreteFont,
  type AppearanceConcreteLook,
  type AppearanceConcretePaint,
  type AppearanceDefaults,
  type AppearanceDensity,
  type AppearanceMode,
  type AppearanceTheme,
  parseAppearanceDefaults,
  resolveAppearanceLook,
} from "@requestport/domain/browser";

/**
 * The six values a `ThemeProvider` and the pre-paint script are handed: the
 * stored theme, density and mode, and the typeface, style set and paint with
 * every `match` resolved through the theme's Look (ruling 255). Browser-safe:
 * the root provider, the head scripts and the appearance editors' preview all
 * derive what they stamp from this one function.
 */
export type AppearancePresentation = {
  theme: AppearanceTheme;
  density: AppearanceDensity;
  mode: AppearanceMode;
  font: AppearanceConcreteFont;
  styleSet: AppearanceConcreteLook;
  paint: AppearanceConcretePaint;
};

/**
 * Re-parses the axes first, so a value off the vocabulary degrades that axis
 * to the fallback before anything is stamped.
 */
export function appearancePresentation(
  appearance: AppearanceDefaults,
): AppearancePresentation {
  const validated = parseAppearanceDefaults(appearance);
  const look = resolveAppearanceLook(validated);
  return {
    theme: validated.theme,
    density: validated.density,
    mode: validated.mode,
    font: look.font,
    styleSet: look.look,
    paint: look.paint,
  };
}
