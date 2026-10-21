import { isE2EEmailMode } from "@requestport/auth/e2e";
import { describe, expect, test } from "vitest";

import { isE2ECspFenceOpen } from "./e2e-csp-fence.js";

const TOKEN = "t".repeat(32);

describe("isE2ECspFenceOpen, the CSP's E2E fence (ruling 174)", () => {
  test.each([
    [
      "E2E mode: test, the flag and a 32-character token",
      {
        NODE_ENV: "test",
        REQUESTPORT_E2E_MODE: "1",
        REQUESTPORT_E2E_TOKEN: TOKEN,
      },
    ],
    [
      "E2E mode under development",
      {
        NODE_ENV: "development",
        REQUESTPORT_E2E_MODE: "1",
        REQUESTPORT_E2E_TOKEN: TOKEN,
      },
    ],
    [
      "production, with the flag and the token",
      {
        NODE_ENV: "production",
        REQUESTPORT_E2E_MODE: "1",
        REQUESTPORT_E2E_TOKEN: TOKEN,
      },
    ],
    [
      "test, without the flag",
      { NODE_ENV: "test", REQUESTPORT_E2E_TOKEN: TOKEN },
    ],
    [
      "test, with a 31-character token",
      {
        NODE_ENV: "test",
        REQUESTPORT_E2E_MODE: "1",
        REQUESTPORT_E2E_TOKEN: TOKEN.slice(1),
      },
    ],
    ["an empty environment", {}],
  ])("is open exactly when auth's E2E predicate is: %s", (_label, env) => {
    expect(isE2ECspFenceOpen(env)).toBe(isE2EEmailMode(env));
  });

  test("is open in E2E mode and closed outside it", () => {
    expect(
      isE2ECspFenceOpen({
        NODE_ENV: "test",
        REQUESTPORT_E2E_MODE: "1",
        REQUESTPORT_E2E_TOKEN: TOKEN,
      }),
    ).toBe(true);
    expect(isE2ECspFenceOpen({ NODE_ENV: "production" })).toBe(false);
  });
});
