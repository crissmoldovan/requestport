import { DomainError } from "@requestport/domain";
import { describe, expect, test } from "vitest";

import { mapFoundationDatabaseError } from "./foundation-repository.js";

describe("foundation database error mapping", () => {
  test.each([
    ["organizations_slug_ci_unique", "slug"],
    ["projects_organization_slug_ci_unique", "slug"],
    ["projects_organization_key_prefix_ci_unique", "keyPrefix"],
    ["project_repositories_provider_slug_ci_unique", "repositoryUrl"],
    ["project_repositories_project_default_unique", "repositoryUrl"],
    ["invitations_organization_email_ci_unique", "email"],
  ])("maps only the exact %s uniqueness constraint", (constraint, field) => {
    const sentinel = "postgres://user:password@db.invalid/private";
    const mapped = mapFoundationDatabaseError({
      cause: {
        code: "23505",
        constraint,
        detail: sentinel,
        query: `SELECT '${sentinel}'`,
      },
    });

    expect(mapped).toBeInstanceOf(DomainError);
    expect(mapped).toMatchObject({ code: "conflict", details: { field } });
    expect(JSON.stringify(mapped)).not.toContain(sentinel);
  });

  test("does not misclassify a lookalike or expose unknown database detail", () => {
    const sentinel = "provider-secret-and-sql-detail";
    const mapped = mapFoundationDatabaseError({
      cause: {
        code: "23505",
        constraint: "organizations_slug_ci_unique_lookalike",
        detail: sentinel,
      },
    });

    expect(mapped).not.toBeInstanceOf(DomainError);
    expect(mapped).toMatchObject({ message: "Foundation persistence failed" });
    expect(JSON.stringify(mapped)).not.toContain(sentinel);
  });
});
