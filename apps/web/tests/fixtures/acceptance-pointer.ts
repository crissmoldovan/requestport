/**
 * The pointer a case is driven with, and what the browser has to be told.
 *
 * A window narrowed to a phone's width is not a phone: it still reports a
 * mouse, so `(pointer: coarse)` does not match and every accommodation the
 * token layer publishes behind that query stays unrendered. Section 13 asks for
 * two things a fine-pointer window cannot answer — that large density stay
 * usable on mobile, and that ultra-compact not produce a target below the
 * design system's floor — and the second is exactly what the installed
 * `@cueplusplus/tokens` re-raises under a coarse pointer.
 *
 * So the pointer is an axis of the case table rather than something a viewport
 * implies at the far end of a driver. A case declares it, the schema closes it,
 * and the runner hands it to the context it opens.
 */

/** The two pointers a case may declare. */
export const acceptancePointers = ["coarse", "fine"] as const;

export type AcceptancePointer = (typeof acceptancePointers)[number];

/**
 * The widths section 13 calls mobile.
 *
 * The section names these as the sizes mobile composition is verified at, and
 * mobile is the coarse-pointer case; the widths it calls desktop are the fine
 * ones. Naming the mobile half here rather than the whole partition means a
 * width added to the table is desktop until someone says otherwise, which is
 * the safe direction: a fine pointer under-reports an accommodation, a coarse
 * one invents a device.
 */
export const mobileViewportWidths: readonly number[] = [390, 768];

/** The pointer a viewport of this width is driven with. */
export function pointerForWidth(width: number): AcceptancePointer {
  return mobileViewportWidths.includes(width) ? "coarse" : "fine";
}

/**
 * What Playwright is told, per pointer.
 *
 * `hasTouch` is the whole of it. It is what moves `(pointer: coarse)` and
 * `(any-pointer: coarse)`, and it is the only context option that does:
 * `isMobile` alone leaves both unmatched, so a context that set it and not
 * this one would emulate a phone everywhere except the place the token layer
 * reads. `isMobile` is deliberately not set on top, because it also enables
 * viewport-meta scaling, which would rescale every width this table measures
 * composition at into a width it never declared.
 */
export function acceptanceHasTouch(pointer: AcceptancePointer): boolean {
  return pointer === "coarse";
}
