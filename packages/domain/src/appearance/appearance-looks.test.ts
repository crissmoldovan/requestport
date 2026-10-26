import { describe, expect, test } from "vitest";

import {
  appearanceLookRegistry,
  appearanceThemeLook,
  resolveAppearanceLook,
} from "./appearance-looks.js";
import * as types from "./appearance-types.js";

/*
  Ruling 255: the font, look and paint axes accept `match`, which follows the
  theme's own Look in cue-ui's Looks registry at 0.29.0; a theme with no Look
  of its own follows cue-ui's classic Look (geist, console, none).
*/

describe("match follows the theme's Look (cue-ui's Looks registry at 0.29.0)", () => {
  test("pins the registry copy, entry for entry, in cue-ui's order", () => {
    expect(
      appearanceLookRegistry.map((look) => [
        look.id,
        look.theme,
        look.font,
        look.look,
        look.paint,
      ]),
    ).toEqual([
      ["classic", "cue", "geist", "console", "none"],
      ["graphite", "graphite", "geist-mono", "graphite", "bevel"],
      ["tender", "tender", "inter-source", "tender", "plume"],
      ["zine", "zine", "dm", "zine", "grain"],
      ["kiln", "kiln", "inter", "kiln", "matte"],
      ["porcelain", "porcelain", "calsans", "porcelain", "glaze"],
      ["ledger", "ledger", "inter", "ledger", "lift"],
      ["command", "command", "fraunces-mono", "command", "grain"],
      ["monolith", "monolith", "geist-mono", "monolith", "none"],
      ["prism", "prism", "inter", "prism", "lift"],
      ["cue-site", "monolith", "jetbrains-mono", "monolith", "none"],
    ]);
  });

  test("resolves a theme to its first Look, and a theme with none to classic", () => {
    expect(appearanceThemeLook("cue")).toEqual({
      font: "geist",
      look: "console",
      paint: "none",
    });
    expect(appearanceThemeLook("graphite")).toEqual({
      font: "geist-mono",
      look: "graphite",
      paint: "bevel",
    });
    // Two Looks are built on monolith; the first one listed wins.
    expect(appearanceThemeLook("monolith")).toEqual({
      font: "geist-mono",
      look: "monolith",
      paint: "none",
    });
    for (const theme of ["requestport", "terminal", "quotamate", "dusk"]) {
      expect(appearanceThemeLook(theme as never), theme).toEqual({
        font: "geist",
        look: "console",
        paint: "none",
      });
    }
  });

  test("resolves only the axes left on match, and keeps an explicit choice", () => {
    expect(
      resolveAppearanceLook({
        theme: "tender",
        font: "match",
        look: "editorial",
        paint: "match",
      }),
    ).toEqual({ font: "inter-source", look: "editorial", paint: "plume" });
    expect(
      resolveAppearanceLook({
        theme: "cue",
        font: "plex",
        look: "match",
        paint: "frost",
      }),
    ).toEqual({ font: "plex", look: "console", paint: "frost" });
  });

  test("every typeface a match can resolve to is one RequestPort offers", () => {
    for (const theme of types.appearanceThemes) {
      const { font, look, paint } = appearanceThemeLook(theme);
      expect(types.appearanceConcreteFonts, theme).toContain(font);
      expect(types.appearanceConcreteLooks, theme).toContain(look);
      expect(types.appearanceConcretePaints, theme).toContain(paint);
    }
  });
});
