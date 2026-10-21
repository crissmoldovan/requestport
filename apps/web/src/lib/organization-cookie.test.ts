import { readFileSync } from "node:fs";

import { describe, expect, test, vi } from "vitest";

import { withoutComments } from "../test/source-text.js";

import {
  CURRENT_ORGANIZATION_COOKIE,
  writeCurrentOrganizationCookie,
} from "./organization-cookie.js";

describe("current organization cookie", () => {
  test.each([
    ["production", true],
    ["development", false],
    ["test", false],
  ] as const)(
    "uses a hardened namespaced preference in %s",
    (nodeEnv, secure) => {
      const set = vi.fn();

      writeCurrentOrganizationCookie(
        { set },
        "00000000-0000-4000-8000-000000000001",
        { NODE_ENV: nodeEnv },
      );

      expect(CURRENT_ORGANIZATION_COOKIE).toBe("requestport.organization_id");
      expect(set).toHaveBeenCalledWith(
        CURRENT_ORGANIZATION_COOKIE,
        "00000000-0000-4000-8000-000000000001",
        {
          httpOnly: true,
          path: "/",
          sameSite: "lax",
          secure,
        },
      );
    },
  );

  test("reads the environment off an object so a build cannot fix it", () => {
    // `next build` folds `process.env.NODE_ENV` to a constant wherever it is
    // written out directly, which is how a built server came to mark this
    // cookie `Secure` while running as `test` — and WebKit refuses a `Secure`
    // cookie over plain loopback where Chromium allows it. A default read off
    // an object is what keeps the answer the running server's.
    const source = readFileSync(
      new URL("./organization-cookie.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/secure:\s*[\w.]*process\.env\.NODE_ENV/u);
    expect(withoutComments(source)).not.toMatch(
      /process\.env\.NODE_ENV\s*===/u,
    );
  });
});
