import { describe, expect, test } from "vitest";

import {
  initialRequestActionState,
  requestBannerMessage,
  requestFieldIssues,
  requestFixedValidationMessage,
  requestValidationError,
} from "./request-action-state.js";

/**
 * Where a typed action failure is allowed to land.
 *
 * Section 7 of the reskin specification splits the two: a failure that names a
 * field becomes a `FieldError` issue on that field, and everything else stays a
 * fixed banner. The split has to be decided from the state alone — a form that
 * guessed would either show a message twice or drop one on the floor.
 */

describe("request action state", () => {
  test("starts idle, with nothing to show anywhere", () => {
    expect(initialRequestActionState).toEqual({ status: "idle" });
    expect(
      requestBannerMessage(initialRequestActionState, ["title"]),
    ).toBeNull();
    expect(
      requestFieldIssues(initialRequestActionState, "title"),
    ).toBeUndefined();
  });

  test("gives a named field its own issue and leaves the banner empty", () => {
    const state = {
      code: "validation_failed",
      field: "title",
      message: "A title is required",
      status: "error",
    } as const;

    expect(requestFieldIssues(state, "title")).toEqual([
      { message: "A title is required" },
    ]);
    expect(requestFieldIssues(state, "descriptionMd")).toBeUndefined();
    expect(requestBannerMessage(state, ["title", "descriptionMd"])).toBeNull();
  });

  test("banners a failure that names no field at all", () => {
    const state = {
      code: "route_denied",
      message: "The current routing policy denies this request.",
      status: "error",
    } as const;

    expect(requestBannerMessage(state, ["title"])).toBe(
      "The current routing policy denies this request.",
    );
    expect(requestFieldIssues(state, "title")).toBeUndefined();
  });

  test("banners a field failure no rendered form owns", () => {
    // A schema may reject a field this particular form never draws — a hidden
    // command value, or a field on a sibling form. Nothing would show it, so
    // the banner takes it rather than the message disappearing.
    const state = {
      code: "validation_failed",
      field: "intent",
      message: "Check the supplied values and try again.",
      status: "error",
    } as const;

    expect(requestBannerMessage(state, ["title", "descriptionMd"])).toBe(
      "Check the supplied values and try again.",
    );
  });

  test("never banners or field-errors a success", () => {
    const state = { message: "Comment posted.", status: "success" } as const;

    expect(requestBannerMessage(state, ["bodyMd"])).toBeNull();
    expect(requestFieldIssues(state, "bodyMd")).toBeUndefined();
  });
});

/**
 * The other half of the split: what a rejected submission is allowed to say.
 *
 * A validator's first issue decides both halves at once — the field it names
 * and the sentence the reader gets. The two are not independent: an issue that
 * names a field has a message written about that field, while an issue that
 * names none would put a validator's own words in a banner, so the banner keeps
 * the fixed sentence instead. `actions.test.ts` proves the real actions route
 * their rejections through here; this suite is where each branch is stated,
 * including the one no current schema can reach through a form.
 */
describe("mapping a rejected submission", () => {
  test("carries the rule's own message on the field the rule names", () => {
    expect(
      requestValidationError([
        {
          message: "Sensitive requests must use restricted visibility",
          path: ["visibility"],
        },
      ]),
    ).toEqual({
      code: "validation_failed",
      field: "visibility",
      message: "Sensitive requests must use restricted visibility",
      status: "error",
    });
  });

  test("keeps the fixed sentence, and no field, for an issue naming none", () => {
    const state = requestValidationError([
      { message: "The submitted combination is not allowed", path: [] },
    ]);

    expect(state).toEqual({
      code: "validation_failed",
      message: requestFixedValidationMessage,
      status: "error",
    });
    // `toEqual` treats an explicit `undefined` as absent, and the banner reads
    // `state.field` to decide whether anything else could show the message.
    expect(Object.hasOwn(state, "field")).toBe(false);
    expect(requestBannerMessage(state, ["visibility"])).toBe(
      requestFixedValidationMessage,
    );
  });

  test("keeps the fixed sentence when there is no issue at all", () => {
    const state = requestValidationError([]);

    expect(state).toEqual({
      code: "validation_failed",
      message: requestFixedValidationMessage,
      status: "error",
    });
    expect(Object.hasOwn(state, "field")).toBe(false);
  });
});
