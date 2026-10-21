/**
 * Why operator credentials are off in this deployment (Plan 13, F3-14): the
 * migration's table is absent, the owner's switch is not `enabled`, or the
 * deployment still mounts `/change-password`.
 */
export type OperatorUnavailableReason =
  | "not-migrated"
  | "switched-off"
  | "change-password-mounted";

export type OperatorActionState = {
  status: "idle" | "success" | "error" | "unavailable";
  message: string;
  /**
   * The field a rejected submission is about, when the schema named one. It is
   * what routes the message to that control's own error line instead of the
   * form's fixed banner.
   */
  field?: string;
  /** Present only on an `unavailable` answer. */
  reason?: OperatorUnavailableReason;
  /** The new key, on an issue or a rotation only: shown once, never stored. */
  plaintextKey?: string;
};

export const initialOperatorActionState: OperatorActionState = {
  status: "idle",
  message: "",
};

/** What the page and every action say while operator credentials are off. */
export const operatorUnavailableMessages: Readonly<
  Record<OperatorUnavailableReason, string>
> = {
  "not-migrated":
    "Operator credentials need a database migration this deployment has not applied yet.",
  "switched-off":
    "Operator credentials are switched off in this deployment. The owner turns them on once their migration is recorded.",
  "change-password-mounted":
    "Operator credentials stay off while this deployment still accepts password changes at /change-password, because a password change there would not revoke them.",
};
