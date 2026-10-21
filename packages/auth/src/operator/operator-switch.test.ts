import { describe, expect, test } from "vitest";

import {
  changePasswordClosed,
  operatorCredentialSwitch,
} from "./operator-switch.js";

/*
  Plan 13, F.3 (F3-14, rulings 46 and 53). The switch alone is not enough:
  while the composition mounts `/change-password`, the answer is off. The
  in-process case that shows the router agrees with this reading, on two real
  Better Auth instances, is in `operator-bearer.integration.test.ts`.
*/

const closed = { options: { disabledPaths: ["/change-password"] } };
const mounted = { options: { disabledPaths: [] } };
const unset = { options: {} };

describe("the operator credential switch", () => {
  test("is on only with enabled and /change-password closed", () => {
    expect(
      operatorCredentialSwitch({ variable: "enabled", authContext: closed }),
    ).toEqual({ enabled: true });
  });

  test.each([
    ["unset", undefined],
    ["disabled", "disabled"],
  ] as const)(
    "is off, switched off, when the variable is %s",
    (_label, variable) => {
      expect(
        operatorCredentialSwitch({ variable, authContext: closed }),
      ).toEqual({ enabled: false, reason: "switched-off" });
    },
  );

  test("changes nothing while /change-password is mounted", () => {
    for (const authContext of [mounted, unset]) {
      expect(
        operatorCredentialSwitch({ variable: "enabled", authContext }),
      ).toEqual({ enabled: false, reason: "change-password-mounted" });
    }
  });

  test("reads the path exactly as the router compares it", () => {
    expect(changePasswordClosed(closed)).toBe(true);
    expect(
      changePasswordClosed({
        options: { disabledPaths: ["/change-password/", "/Change-Password"] },
      }),
    ).toBe(false);
    expect(
      changePasswordClosed({
        options: { disabledPaths: ["/sign-up/email", "/change-password"] },
      }),
    ).toBe(true);
  });
});
