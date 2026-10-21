import { describe, expect, test } from "vitest";

import { validateCommandContext } from "./context.js";
import {
  hasControlCharacters,
  normalizeDescription,
  normalizeEmail,
  normalizeKeyPrefix,
  normalizeName,
  normalizeSlug,
  validateOpaqueId,
} from "./validation.js";

function expectSafeValidationFailure(run: () => unknown, field: string) {
  expect(run).toThrowError(
    expect.objectContaining({
      code: "validation_failed",
      details: { field },
    }),
  );
}

describe("runtime-safe public validation", () => {
  test.each(["\u0000", "\u001f", "\u007f", "\u0085", "\u009f"])(
    "recognizes the full forbidden control range %#",
    (value) => {
      expect(hasControlCharacters(value)).toBe(true);
    },
  );

  test.each([
    [() => hasControlCharacters(null as never), "value"],
    [() => normalizeEmail(undefined as never), "email"],
    [() => normalizeName(42 as never), "name"],
    [() => normalizeSlug({} as never), "slug"],
    [() => normalizeDescription([] as never), "description"],
    [() => normalizeKeyPrefix(null as never), "keyPrefix"],
    [() => validateOpaqueId(undefined as never, "userId"), "userId"],
  ])(
    "returns a typed validation failure for malformed JS input",
    (run, field) => {
      expectSafeValidationFailure(run, field);
    },
  );

  test.each([null, undefined, 42, {}, []])(
    "rejects malformed command context %j without a raw TypeError",
    (context) => {
      expectSafeValidationFailure(
        () => validateCommandContext(context as never),
        "context",
      );
    },
  );

  test("does not reflect a malformed runtime field name", () => {
    const sentinel = "secret-field-sentinel";
    let error: unknown;
    try {
      validateOpaqueId(null, sentinel as never);
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      code: "validation_failed",
      details: { field: "value" },
    });
    expect(JSON.stringify(error)).not.toContain(sentinel);
  });
});
