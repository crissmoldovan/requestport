import { describe, expect, test, vi } from "vitest";

import { DomainError } from "./errors.js";

/*
  DomainError's brand (Plan 13, H.5; manifest-h.md §2.7.1; ruling 143).

  A process that serves Next beside the host holds two copies of this module,
  the host's and Next's. There, Next's server actions call the host's core,
  and check what it throws with `instanceof DomainError` against Next's
  class. A second copy is made here as this module evaluated again:
  `vi.resetModules()` and then a fresh import.
*/
async function secondCopy(): Promise<typeof import("./errors.js")> {
  vi.resetModules();
  return import("./errors.js");
}

describe("instanceof DomainError", () => {
  test("holds for this copy's own errors, as before", () => {
    const error = new DomainError("not_found", "Missing");

    expect(error instanceof DomainError).toBe(true);
    expect(error instanceof Error).toBe(true);
    expect(error).toMatchObject({
      name: "DomainError",
      code: "not_found",
      message: "Missing",
    });
  });

  test("holds for an error a second copy of the module built, both ways", async () => {
    const copy = await secondCopy();

    expect(copy.DomainError).not.toBe(DomainError);
    expect(
      new copy.DomainError("validation_failed", "Bad") instanceof DomainError,
    ).toBe(true);
    expect(
      new DomainError("conflict", "Changed") instanceof copy.DomainError,
    ).toBe(true);
  });

  test("does not hold for an unbranded Error named DomainError", () => {
    const named = Object.assign(new Error("Missing"), {
      name: "DomainError",
      code: "not_found",
      details: {},
    });

    expect(named instanceof DomainError).toBe(false);
  });

  test("does not hold for a value that carries the brand but is not an Error", () => {
    const forged = {
      [Symbol.for("requestport.domain-error")]: true,
      name: "DomainError",
      code: "not_found",
    };

    expect(forged instanceof DomainError).toBe(false);
  });

  test("answers false for null, undefined and primitives", () => {
    const values: unknown[] = [null, undefined, "DomainError", 0, true];

    for (const value of values)
      expect(value instanceof DomainError).toBe(false);
  });

  test("a subclass answers by its own identity, not by the brand", () => {
    class NarrowerError extends DomainError {}

    expect(new NarrowerError("conflict", "x") instanceof NarrowerError).toBe(
      true,
    );
    expect(new NarrowerError("conflict", "x") instanceof DomainError).toBe(
      true,
    );
    expect(new DomainError("conflict", "x") instanceof NarrowerError).toBe(
      false,
    );
  });
});

describe("the brand", () => {
  const brand = Symbol.for("requestport.domain-error");

  test("is an own property that is not enumerable, so what serialises or spreads an error is unchanged", () => {
    const error = new DomainError("not_found", "Missing", { id: "a" });

    expect(Object.getOwnPropertyDescriptor(error, brand)).toEqual({
      value: true,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    expect(Object.getOwnPropertySymbols({ ...error })).toEqual([]);
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      name: "DomainError",
      code: "not_found",
      details: { id: "a" },
    });
  });
});
