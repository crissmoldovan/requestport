import { describe, expect, test } from "vitest";
import { ZodError } from "zod";

import { parseServerEnv } from "./server-schema.js";

/*
  The server environment parses as it did on zod 4.4.3, which RequestPort
  0.2.0 published, though the workspace runs zod 4.6.7: lengths in UTF-16
  code units, a URL kept as given, and 4.4.3's email pattern in an issue
  (the copies of `@requestport/domain`'s `zod-compat.ts` helpers in
  `server-schema.ts`).
*/

const env = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://localhost:5432/requestport",
  BETTER_AUTH_SECRET: "a-very-long-test-secret-that-is-at-least-32-characters",
  BETTER_AUTH_URL: "http://localhost:3000",
  RESEND_API_KEY: "re_test_api_key",
  RESEND_FROM_EMAIL: "hello@example.com",
};

const emoji = "\u{1F600}";

function issuesOf(run: () => unknown) {
  try {
    run();
  } catch (error) {
    if (error instanceof ZodError) return error.issues;
    throw error;
  }
  return [];
}

describe("the server environment keeps zod 4.4.3's string rules", () => {
  test("a secret is measured in UTF-16 code units: sixteen emoji are thirty-two", () => {
    const parsed = parseServerEnv({
      ...env,
      BETTER_AUTH_SECRET: emoji.repeat(16),
    });
    expect(parsed.BETTER_AUTH_SECRET).toBe(emoji.repeat(16));
  });

  test("a version of 33 emoji, 66 units, is over its 64", () => {
    expect(
      issuesOf(() =>
        parseServerEnv({
          ...env,
          REQUESTPORT_WORKSPACE_KEK_VERSION: emoji.repeat(33),
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        code: "too_big",
        maximum: 64,
        path: ["REQUESTPORT_WORKSPACE_KEK_VERSION"],
      }),
    ]);
  });

  test("a URL keeps a tab inside it, as given", () => {
    const parsed = parseServerEnv({
      ...env,
      BETTER_AUTH_URL: "http://local\thost:3000",
    });
    expect(parsed.BETTER_AUTH_URL).toBe("http://local\thost:3000");
  });

  test("a refused address names 4.4.3's email pattern", () => {
    expect(
      issuesOf(() =>
        parseServerEnv({ ...env, RESEND_FROM_EMAIL: "a..b@example.com" }),
      ),
    ).toEqual([
      expect.objectContaining({
        code: "invalid_format",
        format: "email",
        pattern:
          "/^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$/",
        path: ["RESEND_FROM_EMAIL"],
      }),
    ]);
  });
});
