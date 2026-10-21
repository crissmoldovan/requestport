import { describe, expect, test } from "vitest";

import { canEditOrganizationAppearance } from "./organization-appearance-authority.js";

describe("who may change the organization's appearance defaults", () => {
  test("an owner of an organization that has defaults", () => {
    expect(canEditOrganizationAppearance({ role: "owner", version: 1 })).toBe(
      true,
    );
  });

  test("nobody else, whatever their role", () => {
    for (const role of ["admin", "member", "", null, undefined]) {
      expect(canEditOrganizationAppearance({ role, version: 3 })).toBe(false);
    }
  });

  // An organization that predates its own defaults row has nothing to change,
  // and an owner reading its effective values is the honest answer.
  test("not even an owner before the defaults exist", () => {
    for (const version of [0, null, undefined]) {
      expect(canEditOrganizationAppearance({ role: "owner", version })).toBe(
        false,
      );
    }
  });
});
