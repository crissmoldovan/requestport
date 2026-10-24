/**
 * Bounds on a command's free-form JSON input (ruling 237 item 3): a value
 * whose schema is `z.json()`, which bounds nothing it nests.
 *
 * Three measures, each against its own bound:
 * - **elements:** every array element and every own object key, at every
 *   level, across all the values together. A scalar adds nothing. This is how
 *   @modelcontextprotocol/server counts a tool call's arguments for
 *   `maxToolInputElements`.
 * - **depth:** how deep each value nests, measured from its own root, which
 *   is at depth 0; each child sits one deeper than its parent. So a scalar,
 *   `[]` and `{}` are 0, `[1]` is 1 and `{"a":{"b":1}}` is 2: the rule of
 *   packages/server's `assertJsonDepth`.
 * - **bytes:** the UTF-8 bytes of the whole input's compact JSON, as
 *   `JSON.stringify` writes it.
 */
export interface FreeFormJsonBounds {
  readonly elements: number;
  readonly depth: number;
  readonly bytes: number;
}

export type FreeFormJsonExcess = keyof FreeFormJsonBounds;

/** The three bounds, by the names a refusal gives them. */
export const freeFormJsonBoundNames: readonly FreeFormJsonExcess[] = [
  "elements",
  "depth",
  "bytes",
];

/**
 * What a refusal by one of these bounds carries besides its message, as its
 * zod issue's `params`: the bound exceeded, and that bound's value.
 * `AtomicCommandBus` (`command.ts`) publishes the two as the refusal's
 * `bound` and `maximum` details, so a caller can tell the three refusals
 * apart, and each from the input's other checks.
 */
export function freeFormJsonRefusal(
  excess: FreeFormJsonExcess,
  bounds: FreeFormJsonBounds,
): { bound: FreeFormJsonExcess; maximum: number } {
  return { bound: excess, maximum: bounds[excess] };
}

/**
 * The first bound, in the order elements, depth, bytes, that `values`
 * (counted together, each nested from its own root) or `whole` (as compact
 * JSON) exceeds, or `undefined` when none is.
 *
 * The walk stops at the first array or object whose elements or keys take
 * the count past the bound, before visiting them, so it visits the values
 * themselves and at most the bound's worth of children; the bytes are measured only once both other
 * bounds hold.
 */
export function freeFormJsonExcess(
  values: Iterable<unknown>,
  whole: unknown,
  bounds: FreeFormJsonBounds,
): FreeFormJsonExcess | undefined {
  const stack: Array<{ value: unknown; depth: number }> = [];
  for (const value of values) stack.push({ value, depth: 0 });
  let elements = 0;
  let deepest = 0;
  while (stack.length > 0) {
    const current = stack.pop() as { value: unknown; depth: number };
    if (current.depth > deepest) deepest = current.depth;
    let children: unknown[] | undefined;
    if (Array.isArray(current.value)) {
      elements += current.value.length;
      if (elements > bounds.elements) return "elements";
      children = current.value;
    } else if (typeof current.value === "object" && current.value !== null) {
      const keys = Object.keys(current.value);
      elements += keys.length;
      if (elements > bounds.elements) return "elements";
      children = keys.map(
        (key) => (current.value as Record<string, unknown>)[key],
      );
    }
    if (children)
      for (const child of children)
        stack.push({ value: child, depth: current.depth + 1 });
  }
  if (deepest > bounds.depth) return "depth";
  const json = JSON.stringify(whole) as string | undefined;
  if (
    json !== undefined &&
    new TextEncoder().encode(json).byteLength > bounds.bytes
  )
    return "bytes";
  return undefined;
}
