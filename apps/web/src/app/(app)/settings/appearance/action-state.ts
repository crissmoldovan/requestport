/**
 * The typed appearance action contract, shared by the server actions and the
 * client forms. It is a plain module on purpose: a `"use server"` file may only
 * export async functions, so the vocabulary the client renders has to live
 * beside it rather than inside it.
 */

export const appearanceActionStatuses = [
  "idle",
  "pending",
  "field_error",
  "global_error",
  "success",
  "version_conflict",
  "context_conflict",
] as const;
export type AppearanceActionStatus = (typeof appearanceActionStatuses)[number];

/** The six axes are the only fields a failure can be attributed to. */
export const appearanceFieldNames = [
  "theme",
  "density",
  "mode",
  "font",
  "look",
  "paint",
] as const;
export type AppearanceFieldName = (typeof appearanceFieldNames)[number];

export const appearanceGlobalErrorCodes = [
  "forbidden",
  "not_initialized",
  "rate_limited",
  "invalid_request",
  "temporarily_unavailable",
  "unexpected_error",
] as const;
export type AppearanceGlobalErrorCode =
  (typeof appearanceGlobalErrorCodes)[number];

export type AppearanceActionState =
  | { status: "idle" }
  | { status: "pending" }
  | { field: AppearanceFieldName; message: string; status: "field_error" }
  | { code: AppearanceGlobalErrorCode; message: string; status: "global_error" }
  | { destination: string; status: "success" }
  | { message: string; status: "version_conflict" }
  | { message: string; status: "context_conflict" };

export type AppearanceFormAction = (
  previousState: AppearanceActionState,
  formData: FormData,
) => Promise<AppearanceActionState>;

export const initialAppearanceActionState: AppearanceActionState = {
  status: "idle",
};

/**
 * Every message the appearance surface can show. They are fixed strings: no
 * query, credential, provider payload, or thrown sentinel ever reaches a
 * rendered banner or field error.
 */
export const appearanceActionMessages = {
  context_conflict: "This form is out of date. Reload the page and try again.",
  field: "Choose one of the listed values.",
  forbidden: "You do not have permission to change these defaults.",
  invalid_request: "The appearance change could not be saved.",
  not_initialized:
    "Organization appearance defaults are not available yet. Try again shortly.",
  rate_limited: "Too many appearance changes. Try again shortly.",
  temporarily_unavailable:
    "Appearance settings are temporarily unavailable. Try again shortly.",
  unexpected_error: "The appearance change could not be saved.",
  version_conflict:
    "Appearance changed in another session. Reload the page and try again.",
} as const;

/** The submitted value that means "inherit" on a personal axis. */
export const appearanceInheritValue = "inherit";

/** Where a successful write lands when the form supplied no usable origin path. */
export const appearanceDefaultDestination = "/settings/appearance";
