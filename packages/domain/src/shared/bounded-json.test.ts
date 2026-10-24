import { describe, expect, test } from "vitest";

import { freeFormJsonExcess } from "./bounded-json.js";

const roomy = { elements: 1_000, depth: 20, bytes: 1_000_000 };

/** `[[[…[leaf]…]]]`: `levels` arrays around `leaf`, which then sits at depth `levels`. */
function nested(levels: number, leaf: unknown = 0): unknown {
  let value = leaf;
  for (let level = 0; level < levels; level += 1) value = [value];
  return value;
}

describe("freeFormJsonExcess", () => {
  test("counts every array element and every own object key, at every level, as the MCP SDK does", () => {
    // 3 elements, 2 in the inner array, 2 keys, 1 key: 8. Scalars add nothing.
    const value = [1, [2, 3], { a: 1, b: { c: 2 } }];
    expect(
      freeFormJsonExcess([value], value, { ...roomy, elements: 8 }),
    ).toBeUndefined();
    expect(freeFormJsonExcess([value], value, { ...roomy, elements: 7 })).toBe(
      "elements",
    );
    for (const scalar of ["text", 0, true, null])
      expect(
        freeFormJsonExcess([scalar], scalar, { ...roomy, elements: 0 }),
      ).toBeUndefined();
  });

  test("counts the values together: the elements bound is for all of them", () => {
    const values = [[0, 0, 0], { a: 0, b: 0 }, "scalar"];
    expect(
      freeFormJsonExcess(values, values, { ...roomy, elements: 5 }),
    ).toBeUndefined();
    expect(freeFormJsonExcess(values, values, { ...roomy, elements: 4 })).toBe(
      "elements",
    );
  });

  test("measures each value's depth from its own root: a scalar, [] and {} are 0, [1] is 1, {a:{b:1}} is 2", () => {
    const depthOf = (value: unknown) => {
      for (let depth = 0; depth <= 20; depth += 1)
        if (freeFormJsonExcess([value], value, { ...roomy, depth }) !== "depth")
          return depth;
      return Number.POSITIVE_INFINITY;
    };
    expect(depthOf("leaf")).toBe(0);
    expect(depthOf([])).toBe(0);
    expect(depthOf({})).toBe(0);
    expect(depthOf([1])).toBe(1);
    expect(depthOf({ a: { b: 1 } })).toBe(2);
    expect(depthOf(nested(8))).toBe(8);
    expect(depthOf(nested(9))).toBe(9);
    // Each of several values from its own root, not from a common one.
    expect(
      freeFormJsonExcess([nested(8), nested(8)], null, { ...roomy, depth: 8 }),
    ).toBeUndefined();
  });

  test("measures the whole as the UTF-8 bytes of its compact JSON (JSON.stringify)", () => {
    // `{"é":"€"}`: 2 bytes for é and 3 for €, 12 in all.
    const whole = { é: "€" };
    expect(
      freeFormJsonExcess(Object.values(whole), whole, { ...roomy, bytes: 12 }),
    ).toBeUndefined();
    expect(
      freeFormJsonExcess(Object.values(whole), whole, { ...roomy, bytes: 11 }),
    ).toBe("bytes");
  });

  test("names the elements bound first, then depth, then bytes", () => {
    const deepAndWide = [nested(9), "x".repeat(100)];
    expect(
      freeFormJsonExcess(deepAndWide, deepAndWide, {
        elements: 1,
        depth: 8,
        bytes: 10,
      }),
    ).toBe("elements");
    expect(
      freeFormJsonExcess(deepAndWide, deepAndWide, {
        elements: 100,
        depth: 8,
        bytes: 10,
      }),
    ).toBe("depth");
    expect(
      freeFormJsonExcess(deepAndWide, deepAndWide, {
        elements: 100,
        depth: 9,
        bytes: 10,
      }),
    ).toBe("bytes");
  });

  test("stops at the first array or object that takes the count past the elements bound, before its children", () => {
    // An array of 2^32 - 1 holes: walking its children would not finish.
    const unwalkable = new Array(2 ** 32 - 1);
    expect(
      freeFormJsonExcess([[0], unwalkable], null, { ...roomy, elements: 10 }),
    ).toBe("elements");
  });
});
