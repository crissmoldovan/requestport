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
 * The two token names a focused element is asked to resolve. Every focus ring
 * the installed package draws is `outline-accent`; `--cue-focus` is the axis
 * the token layer publishes for the same purpose, and either satisfies §13.
 */
export const focusTokenNames = ["--cue-accent", "--cue-focus"] as const;

/**
 * The fallback a page substitutes when a token name resolves to nothing.
 *
 * Fully transparent, which no focus ring can be — so an unresolved token reads
 * as "this page has no focus colour" rather than silently matching whatever
 * colour the probe inherited.
 */
export const unresolvedFocusToken = "rgba(0, 0, 0, 0)";

/** What one focused element reported about how it shows focus. */
export type FocusIndicatorSample = {
  readonly boxShadow: string;
  readonly outlineColor: string;
  readonly outlineStyle: string;
  readonly outlineWidth: string;
  readonly tag: string;
  /** `focusTokenNames`, resolved in that element's own cascade. */
  readonly tokenColors: readonly string[];
};

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
    .filter((color) => color.length > 0 && color !== unresolvedFocusToken);
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
