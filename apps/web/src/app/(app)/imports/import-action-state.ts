export type ImportActionState = {
  status: "idle" | "success" | "error";
  message: string;
  /**
   * The field a rejected submission is about, when the schema or the domain
   * named one. It is what routes the message to that control's own error line
   * instead of the form's fixed banner.
   */
  field?: string;
};

export const initialImportActionState: ImportActionState = {
  status: "idle",
  message: "",
};
