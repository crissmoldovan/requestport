export type OperationsActionState = {
  status: "idle" | "success" | "error";
  message: string;
  /**
   * The field a rejected submission is about, set when the schema, or the
   * bus's refusal of a hold reason as secret material, named one. That refusal
   * carries no field of its own; `createRetentionHoldAction` names the reason,
   * the form's only free text. It is what routes the message to that control's
   * own error line instead of the form's fixed banner.
   */
  field?: string;
};

export const initialOperationsActionState: OperationsActionState = {
  status: "idle",
  message: "",
};
