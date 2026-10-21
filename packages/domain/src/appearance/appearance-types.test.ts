import { describe, expect, test } from "vitest";

import {
  appearanceAxes,
  appearanceDensities,
  appearanceFallback,
  appearanceModes,
  appearanceThemes,
  isAppearanceDensity,
  isAppearanceMode,
  isAppearanceTheme,
  parseAppearanceDefaults,
  parseAppearanceOverrides,
} from "./appearance-types.js";

describe("locked appearance vocabulary", () => {
  test("exposes exactly the nine themes, three densities, and three modes", () => {
    expect(appearanceThemes).toEqual([
      "requestport",
      "cue",
      "terminal",
      "signal",
      "venu",
      "hivehub",
      "dusk",
      "luma",
      "snuffle",
    ]);
    expect(appearanceDensities).toEqual(["ultra-compact", "normal", "large"]);
    expect(appearanceModes).toEqual(["system", "dark", "light"]);
    expect(appearanceAxes).toEqual(["theme", "density", "mode"]);
  });

  test("pins the RequestPort fallback triple", () => {
    expect(appearanceFallback).toEqual({
      theme: "requestport",
      density: "ultra-compact",
      mode: "system",
    });
  });

  test("guards accept only exact locked literals", () => {
    for (const theme of appearanceThemes)
      expect(isAppearanceTheme(theme)).toBe(true);
    for (const density of appearanceDensities) {
      expect(isAppearanceDensity(density)).toBe(true);
    }
    for (const mode of appearanceModes)
      expect(isAppearanceMode(mode)).toBe(true);

    for (const invalid of [
      "midnight",
      "RequestPort",
      " requestport",
      "requestport ",
      "",
      null,
      undefined,
      42,
      ["requestport"],
      { theme: "requestport" },
    ]) {
      expect(isAppearanceTheme(invalid), JSON.stringify(invalid)).toBe(false);
    }
    for (const invalid of ["cosy", "compact", "ultra compact", "Large", 0]) {
      expect(isAppearanceDensity(invalid), String(invalid)).toBe(false);
    }
    for (const invalid of ["auto", "Dark", "os", true]) {
      expect(isAppearanceMode(invalid), String(invalid)).toBe(false);
    }
  });
});

describe("runtime parsing of untrusted appearance values", () => {
  test("keeps every valid personal override and drops every malformed axis", () => {
    expect(
      parseAppearanceOverrides({
        theme: "venu",
        density: "large",
        mode: "dark",
      }),
    ).toEqual({ theme: "venu", density: "large", mode: "dark" });

    expect(
      parseAppearanceOverrides({
        theme: "midnight",
        density: "cosy",
        mode: "auto",
      }),
    ).toEqual({ theme: null, density: null, mode: null });

    expect(
      parseAppearanceOverrides({ theme: "cue", density: 7, mode: undefined }),
    ).toEqual({ theme: "cue", density: null, mode: null });
  });

  test("treats non-object personal input as fully inherited", () => {
    for (const invalid of [null, undefined, "cue", 4, [], () => undefined]) {
      expect(parseAppearanceOverrides(invalid)).toEqual({
        theme: null,
        density: null,
        mode: null,
      });
    }
  });

  test("replaces every malformed organization axis with the fixed fallback", () => {
    expect(
      parseAppearanceDefaults({
        theme: "terminal",
        density: "normal",
        mode: "light",
      }),
    ).toEqual({ theme: "terminal", density: "normal", mode: "light" });

    expect(
      parseAppearanceDefaults({ theme: "midnight", density: null, mode: 3 }),
    ).toEqual(appearanceFallback);

    expect(parseAppearanceDefaults(undefined)).toEqual(appearanceFallback);
  });
});
