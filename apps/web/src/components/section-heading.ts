/**
 * How a section heading and the detail beside it share one line.
 *
 * The heading is what tells a person where they are; the count or note beside
 * it is detail. When the line is too short for both, the detail is what gives
 * way. The first version of this had it backwards — every heading wore
 * `truncate`, so *Pending invitations* rendered as `Pending invita…` beside an
 * intact `0 awaiting acceptance`, and a panel title rendered as `P…`.
 *
 * A heading therefore wraps rather than truncating: `truncate` sets
 * `white-space: nowrap`, which makes the heading's min-content width its whole
 * string and leaves an ellipsis as the only way to fit. Without it the heading
 * shrinks to its longest word and takes a second line, which is legible where
 * `P…` is not. The note truncates instead, and carries `min-w-0` so that it can
 * — a flex item's default `min-width: auto` refuses to shrink below its own
 * content, and `truncate` alone would never engage.
 *
 * These live here rather than beside any one surface because they were four
 * identical copies in four files, which is how the rule came to be wrong in all
 * four at once.
 */
export const sectionHeadingClasses =
  "font-mono text-(length:--cue-text-emphasis) font-medium text-fg";

export const sectionHeadingNoteClasses = "min-w-0 truncate text-fg-subtle";
