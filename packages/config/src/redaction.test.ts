import { expect, test } from "vitest";

import { redactLogValue, safeLogFields } from "./redaction.js";

test("redacts matching keys recursively while preserving useful fields", () => {
  expect(
    safeLogFields({
      authorization: "Bearer abc",
      requestId: "req_1",
      nested: {
        api_key: "secret-api-key",
        count: 2,
      },
      attempts: [{ magicLink: "secret-link" }, "kept"],
    }),
  ).toEqual({
    authorization: "[REDACTED]",
    requestId: "req_1",
    nested: {
      api_key: "[REDACTED]",
      count: 2,
    },
    attempts: [{ magicLink: "[REDACTED]" }, "kept"],
  });
});

test("truncates long strings to four KiB", () => {
  expect(redactLogValue("a".repeat(4_097))).toBe("a".repeat(4_096));
});

test("handles cycles without reading getters", () => {
  let getterRead = false;
  const input: Record<string, unknown> = { requestId: "req_1" };
  input.self = input;
  Object.defineProperty(input, "secret", {
    enumerable: true,
    get() {
      getterRead = true;
      return "must-not-be-read";
    },
  });

  expect(safeLogFields(input)).toEqual({
    requestId: "req_1",
    self: "[Circular]",
    secret: "[REDACTED]",
  });
  expect(getterRead).toBe(false);
});

test("handles deeply nested values without overflowing", () => {
  let input: unknown = "leaf";

  for (let depth = 0; depth < 200; depth += 1) {
    input = { child: input };
  }

  expect(() => redactLogValue(input)).not.toThrow();
});

test("does not invoke proxy traps", () => {
  const input = new Proxy(
    { token: "must-not-be-read" },
    {
      get() {
        throw new Error("proxy get trap invoked");
      },
      ownKeys() {
        throw new Error("proxy ownKeys trap invoked");
      },
    },
  );

  expect(redactLogValue(input)).toBe("[Unserializable]");
});
