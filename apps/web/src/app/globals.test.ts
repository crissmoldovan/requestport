import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

import { appThemes } from "../lib/app-themes.js";

const stylesheet = readFileSync(
  new URL("./globals.css", import.meta.url),
  "utf8",
);

/** Every `@import` specifier in the stylesheet, in order. */
function imports(source: string): string[] {
  return [...source.matchAll(/^@import "([^"]+)";$/gmu)].map(
    (match) => match[1] ?? "",
  );
}

describe("the application stylesheet", () => {
  test("imports every registered theme, after the CUE++ stylesheet", () => {
    // The base ships a bare `:root` palette at the same specificity as a
    // theme's `[data-theme]` block, so whichever is declared later wins. A
    // theme imported ahead of `styles.css`, or registered and never imported,
    // stamps its own name on the document and paints the blank base.
    expect(imports(stylesheet)).toEqual([
      "tailwindcss",
      "@cueplusplus/ui/styles.css",
      ...appThemes.map((theme) => `${theme.package}/theme.css`),
    ]);
  });
});

/**
 * The RequestPort colours as the installed theme package ships them.
 *
 * `@cueplusplus/theme-requestport@1.0.1` has two colours below WCAG AA. The
 * correction is cue-ui#117, which publishes as the next patch. PR #43 restated
 * the corrected values in `globals.css` while no theme package could be
 * downloaded; with the packages installed that block would be a fork of the
 * palette, and the audit forbids a local theme block anyway, so the correction
 * has to arrive in the package. This fails if an install brings the old one.
 */
describe("the installed RequestPort theme", () => {
  const theme = readFileSync(
    createRequire(import.meta.url).resolve("@requestport/theme/theme.css"),
    "utf8",
  );

  test("carries the AA corrections in both modes", () => {
    for (const corrected of [
      "--cue-fg-subtle: #5b6165",
      "--cue-accent: #a14026",
      "--cue-focus: #a14026",
      "--cue-selection: rgba(161,64,38,0.18)",
      "--cue-fg-subtle: #83888c",
    ]) {
      expect(theme).toContain(corrected);
    }
  });

  test("no longer carries the values below AA", () => {
    for (const uncorrected of ["#62696d", "#b8492b", "#81868a"]) {
      expect(theme).not.toContain(uncorrected);
    }
  });
});
