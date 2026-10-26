/**
 * Whether a focused control shows focus the way this design system shows it.
 *
 * Section 13 does not ask for *a* focus indicator; it asks for one that comes
 * from the CUE++ focus token and stays visible on every theme and mode. Those
 * are different claims, and only the first can be judged from an outline's
 * shape: the browser's own ring is a real, visible, correctly shaped ring, so a
 * rule that reads width and style alone accepts the exact thing the section
 * forbids. The colour is what tells them apart, so it is read here — and read
 * against what the page itself resolved the token to, not against a literal
 * this file would have to keep in step with nine themes.
 *
 * This is a pure function over one reading so it can be failed on purpose in
 * the node lane. A rule that only ever runs inside a browser is a rule nobody
 * can prove says anything.
 */

/**
 * The two token names a focused element is asked to resolve, and either
 * satisfies §13. Since `@cueplusplus/ui` 0.17.0 every keyboard ring the
 * installed package draws is `--cue-focus`. At 0.14.1 every ring but two was
 * `outline-accent`, which is why `--cue-accent` is here; the two, the recessed
 * field chassis's and the grouped field's, were `outline-(--cue-focus)`.
 */
export const focusTokenNames = ["--cue-accent", "--cue-focus"] as const;

/**
 * The fallback a page substitutes when a token name resolves to nothing.
 *
 * Fully transparent, which no focus ring can be — so an unresolved token reads
 * as "this page has no focus colour" rather than silently matching whatever
 * colour the probe inherited. Through the mix in `focusTokenExpressions` the
 * same fallback reads `oklab(0 0 0 / 0)`, and is just as unresolved.
 */
export const unresolvedFocusToken = "rgba(0, 0, 0, 0)";

/**
 * The CSS the browser lane resolves for one token name: the token as written,
 * and the token mixed in oklab at 100% with transparent.
 *
 * `getComputedStyle` reports a colour in the notation it was computed in, not
 * in one canonical form. A ring painted `var(--cue-focus)` reads as the token
 * does: `rgb(230, 106, 69)` for `#e66a45`. A recessed field's ring has been
 * painted `color-mix(in oklab, var(--cue-focus) var(--cue-style-field-focus-mix, 15%), transparent)`
 * since `@cueplusplus/ui` 0.24.0, and at a 100% share, the share every field
 * inside `data-field-edge="contrast"` takes, it reads
 * `oklab(0.668073 0.129787 0.0987645)`: the same colour, another string
 * (headless Chrome 155, 2026-10-25). The second expression is that mix with
 * the token in it, so the lane has that string to compare with. At the
 * library's default 15% share the ring reads `oklab(… / 0.15)`, which matches
 * neither expression, so a faint field ring still fails.
 */
export function focusTokenExpressions(name: string): readonly string[] {
  return [
    `var(${name}, ${unresolvedFocusToken})`,
    `color-mix(in oklab, var(${name}, ${unresolvedFocusToken}) 100%, transparent)`,
  ];
}

/** What one focused element reported about how it shows focus. */
export type FocusIndicatorSample = {
  readonly boxShadow: string;
  readonly outlineColor: string;
  readonly outlineStyle: string;
  readonly outlineWidth: string;
  readonly tag: string;
  /**
   * Each of `focusTokenNames` through `focusTokenExpressions`, resolved where
   * the focused element sits (in its parent's cascade).
   */
  readonly tokenColors: readonly string[];
};

/**
 * Whether a resolved token colour is fully transparent: the fallback as
 * written, or with an alpha of zero after a slash, as the mix reports it.
 */
function transparent(color: string): boolean {
  return color === unresolvedFocusToken || /\/\s*0\)$/u.test(color);
}

/** The narrowest ring a reader can be expected to see, in CSS pixels. */
const minimumRingWidth = 1;

function drawnFrom(sample: FocusIndicatorSample, colors: readonly string[]) {
  const width = Number.parseFloat(sample.outlineWidth);
  const outlined =
    sample.outlineStyle !== "none" &&
    Number.isFinite(width) &&
    width >= minimumRingWidth;
  const shadowed = sample.boxShadow !== "none";

  return {
    outlined,
    shadowed,
    tokenised:
      (outlined && colors.includes(sample.outlineColor.trim())) ||
      (shadowed && colors.some((color) => sample.boxShadow.includes(color))),
  };
}

/**
 * Why this reading fails the contract, or nothing.
 *
 * The reason names the element and what it actually drew, because "focus is
 * wrong somewhere on this page" is not a finding anyone can act on.
 */
export function focusIndicatorFailure(
  sample: FocusIndicatorSample,
): string | undefined {
  const colors = sample.tokenColors
    .map((color) => color.trim())
    .filter((color) => color.length > 0 && !transparent(color));
  if (colors.length === 0) return `${sample.tag}|no-focus-token`;

  const drawn = drawnFrom(sample, colors);
  if (drawn.tokenised) return undefined;
  if (!drawn.outlined && !drawn.shadowed) return `${sample.tag}|no-indicator`;

  return `${sample.tag}|untokenized:${
    drawn.outlined ? sample.outlineColor.trim() : sample.boxShadow
  }`;
}

export function focusIndicatorFailures(
  samples: readonly FocusIndicatorSample[],
): string[] {
  return samples
    .map((entry) => focusIndicatorFailure(entry))
    .filter((reason): reason is string => reason !== undefined);
}
