import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "vitest";

import { isUnauthorizedAPIError } from "./better-auth-errors.js";

/*
  Better Auth's `APIError`, read by name (Plan 13, H.5; manifest-h.md §2.7.1).
  This package does not depend on `better-auth`, so its own class is loaded
  as `@requestport/auth`, which composes Better Auth, resolves it.
*/
type BetterAuthAPIError = new (
  status: string,
  body?: Record<string, unknown>,
) => Error & { status: unknown };

const authRequire = createRequire(
  new URL("../../auth/package.json", import.meta.url),
);
const { APIError } = (await import(
  pathToFileURL(authRequire.resolve("better-auth")).href
)) as { APIError: BetterAuthAPIError };

/** Better Auth's APIError as another copy of `better-auth` builds it: another class, with the same name and status. */
class AnotherCopysAPIError extends Error {
  readonly status: string;

  constructor(status: string) {
    super(status.toLowerCase());
    this.name = "APIError";
    this.status = status;
  }
}

describe("isUnauthorizedAPIError", () => {
  test("accepts Better Auth's own APIError with the status UNAUTHORIZED", () => {
    expect(
      isUnauthorizedAPIError(
        new APIError("UNAUTHORIZED", {
          code: "unauthorized",
          message: "unauthorized",
        }),
      ),
    ).toBe(true);
  });

  test("accepts another copy's APIError, and a plain object with that name and status", () => {
    expect(
      isUnauthorizedAPIError(new AnotherCopysAPIError("UNAUTHORIZED")),
    ).toBe(true);
    expect(
      isUnauthorizedAPIError({ name: "APIError", status: "UNAUTHORIZED" }),
    ).toBe(true);
  });

  test("refuses an APIError with any other status", () => {
    expect(
      isUnauthorizedAPIError(new APIError("FORBIDDEN", { message: "no" })),
    ).toBe(false);
    expect(
      isUnauthorizedAPIError(new AnotherCopysAPIError("BAD_REQUEST")),
    ).toBe(false);
  });

  test("refuses an error of another name with the status UNAUTHORIZED, and anything that is not an object", () => {
    expect(
      isUnauthorizedAPIError(
        Object.assign(new Error("unauthorized"), { status: "UNAUTHORIZED" }),
      ),
    ).toBe(false);
    for (const value of [null, undefined, "APIError", 401]) {
      expect(isUnauthorizedAPIError(value)).toBe(false);
    }
  });
});
