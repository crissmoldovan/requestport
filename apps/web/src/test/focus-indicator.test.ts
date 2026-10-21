import { describe, expect, test } from "vitest";

import {
  type FocusIndicatorSample,
  focusIndicatorFailures,
  focusTokenNames,
  unresolvedFocusToken,
} from "../../tests/fixtures/focus-indicator.js";

/**
 * The rule the browser lane applies to a focused control.
 *
 * The matrix has exactly one executable check on focus indication, and it read
 * no colour: it failed only when the outline was absent or hairline *and* there
 * was no shadow, which the browser's own default ring satisfies. A Chromium
 * probe of an unstyled button focused by Tab reports `auto`, `1px`,
 * `rgb(0, 95, 204)` and no shadow — accepted by that rule, and forbidden by
 * section 13, which requires the indicator to come from the CUE++ focus token.
 *
 * So the rule is a pure function over what one focused element reported,
 * proven here rather than only in a browser nobody can fail deliberately.
 */

/** The theme's focus colours, as a page would report them resolved. */
const cueAccent = "rgb(0, 255, 255)";
const cueFocus = "rgb(255, 255, 255)";

function sample(
  overrides: Partial<FocusIndicatorSample>,
): FocusIndicatorSample {
  return {
    boxShadow: "none",
    outlineColor: cueAccent,
    outlineStyle: "solid",
    outlineWidth: "2px",
    tag: "button",
    tokenColors: [cueAccent, cueFocus],
    ...overrides,
  };
}

describe("the focus indicator rule", () => {
  test("names the tokens the browser lane resolves", () => {
    expect(focusTokenNames).toEqual(["--cue-accent", "--cue-focus"]);
    expect(unresolvedFocusToken).toBe("rgba(0, 0, 0, 0)");
  });

  test("accepts a ring drawn from a CUE++ focus token", () => {
    expect(focusIndicatorFailures([sample({})])).toEqual([]);
    expect(
      focusIndicatorFailures([
        sample({ outlineColor: cueFocus, outlineWidth: "3px" }),
      ]),
    ).toEqual([]);
  });

  test("accepts a ring a shadow draws from the same token", () => {
    expect(
      focusIndicatorFailures([
        sample({
          boxShadow: `${cueFocus} 0px 0px 0px 2px`,
          outlineStyle: "none",
          outlineWidth: "0px",
        }),
      ]),
    ).toEqual([]);
  });

  /**
   * The exact reading a Chromium probe returned for an unstyled button focused
   * by Tab. Nothing about its shape is wrong — it is a real, visible ring — and
   * that is the point: only its colour says it is the user agent's and not this
   * design system's.
   */
  test("refuses the browser's own default ring", () => {
    const failures = focusIndicatorFailures([
      sample({
        outlineColor: "rgb(0, 95, 204)",
        outlineStyle: "auto",
        outlineWidth: "1px",
      }),
    ]);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("button");
    expect(failures[0]).toContain("rgb(0, 95, 204)");
  });

  test("refuses a shadow that names no token either", () => {
    expect(
      focusIndicatorFailures([
        sample({
          boxShadow: "rgb(0, 95, 204) 0px 0px 0px 2px",
          outlineStyle: "none",
          outlineWidth: "0px",
        }),
      ]),
    ).toHaveLength(1);
  });

  test("refuses a control that shows no focus at all", () => {
    expect(
      focusIndicatorFailures([
        sample({ outlineStyle: "none", outlineWidth: "0px" }),
      ]),
    ).toHaveLength(1);
    expect(
      focusIndicatorFailures([sample({ outlineWidth: "0.5px" })]),
    ).toHaveLength(1);
  });

  // A token that did not resolve is not permission to skip the check: the page
  // would then have no focus colour of its own to draw with.
  test("refuses a sample whose tokens never resolved", () => {
    expect(
      focusIndicatorFailures([
        sample({
          outlineColor: unresolvedFocusToken,
          tokenColors: [unresolvedFocusToken, unresolvedFocusToken],
        }),
      ]),
    ).toHaveLength(1);
  });

  test("reports every failing control and no passing one", () => {
    expect(
      focusIndicatorFailures([
        sample({}),
        sample({ outlineColor: "rgb(0, 95, 204)", tag: "a" }),
        sample({ outlineColor: "rgb(0, 95, 204)", tag: "input" }),
      ]),
    ).toHaveLength(2);
  });
});
