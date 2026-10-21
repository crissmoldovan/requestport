export type RequestActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | {
      status: "error";
      code: string;
      message: string;
      field?: string;
    };

export const initialRequestActionState: RequestActionState = { status: "idle" };

/** What every rejected submission says when no field can be named. */
export const requestFixedValidationMessage =
  "Check the supplied values and try again.";

/**
 * One Standard Schema issue, in the only two parts this mapping reads.
 *
 * Declared structurally rather than as Zod's own type so the module the client
 * bundle imports stays independent of the validator the server happens to use.
 */
export type RequestValidationIssue = {
  readonly message: string;
  readonly path: readonly PropertyKey[];
};

/**
 * A rejected submission, addressed to the field it is about.
 *
 * The schema's own message travels with the field name, because that is what
 * the field's error line shows: `visibility` failing the sensitivity refinement
 * used to arrive as the same eight words as a malformed UUID, which told a
 * reader nothing about which of the two values to change. An issue that names
 * no field keeps the fixed message and stays in the banner, so no validator's
 * wording about the submission as a whole can reach the page through this path.
 *
 * It lives here, beside the two readers of the state it builds, because the
 * "use server" module that calls it may export nothing but async actions —
 * neither branch would otherwise be reachable from a test.
 */
export function requestValidationError(
  issues: readonly RequestValidationIssue[],
): RequestActionState {
  const issue = issues[0];
  const field = issue?.path[0]?.toString();

  return {
    status: "error",
    code: "validation_failed",
    ...(field ? { field } : {}),
    message: field
      ? (issue?.message ?? requestFixedValidationMessage)
      : requestFixedValidationMessage,
  };
}

/**
 * The issues a field's own error line should show, or nothing.
 *
 * Section 7 of the reskin specification puts a server-side field failure on the
 * owning field rather than in a banner, in the shape every Standard Schema
 * validator reports — which is exactly what CUE++'s `FieldError issues` takes.
 */
export function requestFieldIssues(
  state: RequestActionState,
  field: string,
): readonly { message: string }[] | undefined {
  return state.status === "error" && state.field === field
    ? [{ message: state.message }]
    : undefined;
}

/**
 * The fixed banner's message, or nothing.
 *
 * A failure that names no field is global by definition. A failure that names a
 * field the caller does not draw is global *in this form*: nothing would show
 * it otherwise, and a message that disappears is worse than one in the wrong
 * place. The caller therefore declares the fields it owns rather than the
 * banner assuming every named field is rendered somewhere.
 */
export function requestBannerMessage(
  state: RequestActionState,
  fields: readonly string[] = [],
): string | null {
  if (state.status !== "error") return null;

  return state.field && fields.includes(state.field) ? null : state.message;
}
