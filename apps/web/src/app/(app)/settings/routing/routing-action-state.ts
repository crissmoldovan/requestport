export type RoutingActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "decision"; allowed: boolean; message: string }
  | {
      status: "error";
      message: string;
      /**
       * The field a rejected submission is about, when the schema named one. It
       * is what routes the message to that control's own error line instead of
       * the form's fixed banner.
       */
      field?: string;
    };

export const initialRoutingActionState: RoutingActionState = { status: "idle" };
