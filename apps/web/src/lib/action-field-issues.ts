/**
 * Where a rejected administration submission is allowed to land.
 *
 * Section 7 of the reskin specification puts a server-side field failure on the
 * field that owns it and leaves every other failure in a fixed banner. The
 * settings, routing, operations and agent action modules each answer with their
 * own state shape, so the rule is written once here against the two parts all
 * of them have — a status and an optional field name — rather than six times
 * against six unions.
 *
 * Nothing in this module reads a thrown error. Callers hand it validator issues
 * or an already-mapped state, so no database, provider or sentinel text can
 * reach a page through this path.
 */

/**
 * One Standard Schema issue, in the only two parts this mapping reads.
 *
 * Declared structurally rather than as Zod's own type so the module the client
 * bundle imports stays independent of the validator the server happens to use.
 */
export type ActionValidationIssue = {
  readonly message: string;
  readonly path: readonly PropertyKey[];
};

/** What a rejected submission says when no field can be named. */
export const fixedValidationMessage =
  "Check the supplied values and try again.";

/**
 * A rejected submission, addressed to the field it is about.
 *
 * The schema's own message travels with the field name, because that is the
 * line the reader sees: a lane slug failing its pattern and a malformed UUID
 * used to arrive as the same eight words, which told nobody which value to
 * change. An issue that names no field keeps the fixed message and stays in the
 * banner.
 */
export function namedValidationFailure(
  issues: readonly ActionValidationIssue[],
): { field?: string; message: string } {
  const issue = issues[0];
  const field = issue?.path[0]?.toString();

  return field
    ? { field, message: issue?.message ?? fixedValidationMessage }
    : { message: fixedValidationMessage };
}

/**
 * The two parts of an action state this mapping reads, in the shape every one
 * of the six action modules already has.
 */
export type FieldAddressedState = {
  readonly status: string;
  readonly field?: string;
  readonly message?: string;
};

/**
 * The issues a field's own error line should show, or nothing.
 *
 * The shape is the one every Standard Schema validator reports, which is
 * exactly what CUE++'s `FieldError issues` takes.
 */
export function actionFieldIssues(
  state: FieldAddressedState,
  field: string,
): readonly { message: string }[] | undefined {
  return state.status === "error" && state.field === field && state.message
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
export function actionBannerMessage(
  state: FieldAddressedState,
  fields: readonly string[] = [],
): string | null {
  if (state.status !== "error" || !state.message) return null;

  return state.field && fields.includes(state.field) ? null : state.message;
}
