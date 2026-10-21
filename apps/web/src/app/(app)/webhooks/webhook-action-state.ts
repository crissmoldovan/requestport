export type WebhookActionState = {
  status: "idle" | "success" | "error";
  message: string;
  plaintextSecret?: string;
  /**
   * The field a rejected submission is about, when the schema or the domain
   * named one. It is what routes the message to that control's own error line
   * instead of the form's fixed banner.
   */
  field?: string;
};

export const initialWebhookActionState: WebhookActionState = {
  status: "idle",
  message: "",
};
