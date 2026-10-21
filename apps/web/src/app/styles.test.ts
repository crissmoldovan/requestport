import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

import {
  auditStylesheet,
  cueFocusRingComposition,
  declarationsIn,
  formatViolation,
  shadowedTokenProperties,
} from "../test/native-cue-audit.js";

async function stylesheet() {
  return readFile(new URL("./globals.css", import.meta.url), "utf8");
}

/** How the audit addresses this one stylesheet. */
const globalsPath = "apps/web/src/app/globals.css";

/**
 * Every declaration written against one selector, wherever in the stylesheet it
 * is written.
 *
 * `filter`, never `find`. A selector may legitimately appear in more than one
 * rule — a base rule and a `@media` refinement of it are the ordinary case —
 * and a contract that resolved the selector to whichever rule came first in
 * source order pinned the base rule and left every later one unmeasured. That
 * is a gap a second rule can be added into behind a green suite, so the
 * contracts below are stated over all of them.
 *
 * The reader is the audit's own `declarationsIn`, rather than a sibling regular
 * expression that agrees with it until a stylesheet is written in Tailwind v4's
 * nested form. A rule that contains a nested block has all of its *own*
 * declarations skipped by an innermost-block match, which is exactly the shape
 * a replacement stylesheet is written in.
 */
function declaredOn(css: string, selector: string) {
  return declarationsIn(css).filter(
    (declaration) => declaration.selector === selector,
  );
}

function declaredValue(css: string, selector: string, property: string) {
  return declaredOn(css, selector).find(
    (declaration) => declaration.property === property,
  )?.value;
}

describe("native CUE++ stylesheet contract", () => {
  test("begins in the published two-line import order", async () => {
    // Stated as what the file starts with, not as the absence of a violation:
    // an absence is also what a stylesheet with no imports at all produces, and
    // the one thing this contract must catch is the rewrite that forgets to
    // re-add `@cueplusplus/ui/styles.css`.
    expect(await stylesheet()).toMatch(
      /^@import "tailwindcss";\n@import "@cueplusplus\/ui\/styles\.css";\n/u,
    );
  });

  test("carries no native-audit violation of any rule", async () => {
    // The retired palette, the recipe classes, the local icon geometry and the
    // second type scale are all gone, so this stylesheet is held to the same
    // empty report the rest of the application source is held to. Measuring it
    // here as well as in the scan is what makes the failure land on the file that
    // caused it.
    expect(
      auditStylesheet(await stylesheet(), globalsPath).map(formatViolation),
    ).toEqual([]);
  });

  test("redeclares no custom property the token layer publishes", async () => {
    // The lesson the retired stylesheet is worth keeping. Tailwind emits the
    // token bridge inside `@layer theme`, and an unlayered `:root` beats every
    // layer — so `--radius-control: 3px` written here silently replaced
    // `calc(var(--cue-radius-control) * var(--cue-radius-scale))` for the
    // installed components that read it, flattening every control corner to one
    // value on every theme while breaking no colour rule and no contract.
    //
    // The names are the installed package's, read from the companion token
    // document rather than restated, so the guard widens with the package.
    const shadowable = shadowedTokenProperties();
    const shadowed = declarationsIn(await stylesheet())
      .filter((declaration) => shadowable.has(declaration.property))
      .map((declaration) => `${declaration.selector}{${declaration.property}}`);

    expect(shadowed).toEqual([]);
  });

  test("paints the document ground, ink, and type from CUE++ tokens", async () => {
    // `<body>` is the one surface no CUE++ component owns: the provider stamps
    // the appearance attributes on it and publishes the font families, but it
    // paints nothing. Every value here therefore has to be a token, so the
    // document follows the resolved theme, density and mode like everything
    // inside it.
    const css = await stylesheet();

    expect({
      background: declaredValue(css, "body", "background"),
      color: declaredValue(css, "body", "color"),
      fontFamily: declaredValue(css, "body", "font-family"),
      fontSize: declaredValue(css, "body", "font-size"),
    }).toEqual({
      background: "var(--cue-bg)",
      color: "var(--cue-fg)",
      fontFamily: "var(--cue-font-sans)",
      fontSize: "var(--cue-text-body)",
    });
  });

  test("lets no rule anywhere repaint the document in a literal", async () => {
    // The other half of the same claim, stated over every rule that touches the
    // document root rather than over the first one found: a second `body` rule
    // added later — in a media query, in a layer, anywhere — may still only
    // reach for a token.
    const css = await stylesheet();
    const literal = [
      ...declaredOn(css, "body"),
      ...declaredOn(css, "html"),
      ...declaredOn(css, ":root"),
    ].filter(
      (declaration) =>
        /^(?:background|color|font)/u.test(declaration.property) &&
        !declaration.value.includes("var(--cue-"),
    );

    expect(literal).toEqual([]);
  });

  test("gives the focus ring its own colour before the ring is drawn", async () => {
    // Section 13 asks for an indicator drawn from the CUE++ focus token and
    // visible on every theme and mode, and the acceptance lane reads the ring
    // in the frame the key press produces it. The installed chassis paints the
    // ring on `:focus-visible` and suppresses it at rest, and carries a
    // transition that covers the outline's colour — so the colour the ring is
    // painted in *changes* when focus lands, and animates from the value the
    // element's outline already had. Nothing declares that value, so it is
    // `currentColor`: the control's own ink. On the primary action that ink is
    // light-on-accent, and the ring the user is shown at the instant of focus
    // is a white ring on a light ground.
    //
    // The chassis belongs to the package, and this stylesheet cannot edit it.
    // What it can do is leave the change nothing to animate: declare the
    // ring's own colour as the resting outline colour, and the ring is that
    // colour in the frame it appears. `outline-color` paints nothing on its
    // own — an outline is only drawn where a style and a width are declared —
    // so the rule reaches every element without changing what any of them
    // look like until one of them takes focus.
    //
    // The colour is read out of the installed package rather than named here,
    // so the resting declaration follows the ring the package actually draws.
    const ring = cueFocusRingComposition();

    expect({
      animated: ring.animated,
      resting: declaredValue(await stylesheet(), "*", "outline-color"),
    }).toEqual({ animated: true, resting: ring.colour });
  });

  test("keeps every app-owned rule inside the reviewed shell surface", async () => {
    // Specification section 5.2 lets RequestPort own shell and responsive
    // composition and nothing else. Naming the selectors the stylesheet is
    // allowed to write is what keeps a retired recipe system from growing back
    // one token-valued rule at a time: every rule below breaks no colour or
    // geometry rule by construction, so no other contract would ever see it.
    //
    // The universal selector is reviewed and is here for the focus ring alone.
    // An indicator belongs to the shell in the same way the document's ground
    // does — no component owns it, because every component is drawn over it —
    // and the declaration behind this selector is held to its own contract by
    // the test above rather than being licensed by appearing here.
    const selectors = [
      ...new Set(declarationsIn(await stylesheet()).map((one) => one.selector)),
    ].sort();

    expect(selectors).toEqual(["*", "body"]);
  });
});
