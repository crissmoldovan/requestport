import { describe, expect, test } from "vitest";

import { canEditOrganizationAppearance } from "./organization-appearance-authority.js";

describe("who may change the organization's appearance defaults", () => {
  // Ruling 255, item 7: "If I am the org administrator, that will apply to
  // that organisation." Owners and admins, as the command allows.
  test("an owner or an admin of an organization that has defaults", () => {
    for (const role of ["owner", "admin"]) {
      expect(canEditOrganizationAppearance({ role, version: 1 }), role).toBe(
        true,
      );
    }
  });

  test("nobody else, whatever their role", () => {
    for (const role of ["member", "Admin", "", null, undefined]) {
      expect(canEditOrganizationAppearance({ role, version: 3 })).toBe(false);
    }
  });

  // An organization that predates its own defaults row has nothing to change,
  // and an owner or admin reading its effective values is the honest answer.
  test("not even an owner or an admin before the defaults exist", () => {
    for (const role of ["owner", "admin"]) {
      for (const version of [0, null, undefined]) {
        expect(canEditOrganizationAppearance({ role, version })).toBe(false);
      }
    }
  });
});
