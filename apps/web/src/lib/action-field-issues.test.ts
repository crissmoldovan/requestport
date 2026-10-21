import { describe, expect, test } from "vitest";

import {
  actionBannerMessage,
  actionFieldIssues,
  fixedValidationMessage,
  namedValidationFailure,
} from "./action-field-issues.js";

/**
 * Where a rejected administration submission is allowed to land.
 *
 * Section 7 of the reskin specification puts a server-side field failure on the
 * owning field and leaves everything else in a fixed banner. The six settings
 * and agent action modules answer with six different state shapes, so the rule
 * is written once against the two parts every one of them has — a status and an
 * optional field name — rather than six times against six unions.
 */

describe("naming the field a rejected submission is about", () => {
  test("carries the schema's own message when an issue names a field", () => {
    expect(
      namedValidationFailure([
        { message: "2–10 uppercase letters or digits.", path: ["keyPrefix"] },
      ]),
    ).toEqual({
      field: "keyPrefix",
      message: "2–10 uppercase letters or digits.",
    });
  });

  test("keeps the fixed message when no issue names a field", () => {
    expect(
      namedValidationFailure([{ message: "Invalid input", path: [] }]),
    ).toEqual({ message: fixedValidationMessage });
    expect(namedValidationFailure([])).toEqual({
      message: fixedValidationMessage,
    });
  });

  test("reads only the first path segment, never a nested detail", () => {
    expect(
      namedValidationFailure([
        { message: "Too long", path: ["requiredWorkspaceFields", 2] },
      ]),
    ).toEqual({ field: "requiredWorkspaceFields", message: "Too long" });
  });
});

describe("routing a failure to a field or to the banner", () => {
  const rejected = {
    field: "slug",
    message: "Lowercase letters, numbers, and single hyphens.",
    status: "error",
  } as const;

  test("gives the owning field its own error line", () => {
    expect(actionFieldIssues(rejected, "slug")).toEqual([
      { message: "Lowercase letters, numbers, and single hyphens." },
    ]);
    expect(actionFieldIssues(rejected, "name")).toBeUndefined();
  });

  test("shows nothing on any field while the submission has not failed", () => {
    expect(
      actionFieldIssues(
        { message: "Organization created.", status: "success" },
        "slug",
      ),
    ).toBeUndefined();
    expect(actionFieldIssues({ status: "idle" }, "slug")).toBeUndefined();
  });

  test("leaves a named field's failure out of the banner that form draws", () => {
    expect(actionBannerMessage(rejected, ["name", "slug"])).toBeNull();
  });

  test("banners a failure whose field this form never drew", () => {
    expect(actionBannerMessage(rejected, ["name"])).toBe(
      "Lowercase letters, numbers, and single hyphens.",
    );
    expect(actionBannerMessage(rejected)).toBe(
      "Lowercase letters, numbers, and single hyphens.",
    );
  });

  test("banners a failure that names no field at all", () => {
    expect(
      actionBannerMessage(
        {
          message: "This record changed. Refresh and try again.",
          status: "error",
        },
        ["name"],
      ),
    ).toBe("This record changed. Refresh and try again.");
  });

  test("says nothing while the submission has not failed", () => {
    expect(
      actionBannerMessage({ message: "Alias added.", status: "success" }),
    ).toBeNull();
    expect(actionBannerMessage({ status: "idle" })).toBeNull();
  });
});
