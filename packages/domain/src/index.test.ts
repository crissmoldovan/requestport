import { expect, test } from "vitest";

import * as publicApi from "./index.js";

test("exposes the framework-independent foundation service API", () => {
  expect(Object.keys(publicApi).sort()).toEqual(
    expect.arrayContaining([
      "BOOTSTRAP_OWNER_ACTOR",
      "DomainError",
      "OrganizationService",
      "ProjectService",
      "bootstrapOwner",
      "canonicalizeGitHubRepository",
      "hasControlCharacters",
      "normalizeDescription",
      "normalizeEmail",
      "normalizeKeyPrefix",
      "normalizeName",
      "normalizeSlug",
      "validationError",
      "validateCommandContext",
      "validateOpaqueId",
      "validateUuid",
    ]),
  );
  expect(publicApi).not.toHaveProperty("db");
  expect(publicApi).not.toHaveProperty("pool");
});
