/**
 * What one consent decision answers with.
 *
 * There is no success state: both decisions end in a redirect the browser
 * follows, so the only thing this form ever has to render back is a refusal.
 * Section 7 of the reskin specification decides where a refusal lands — on the
 * control it is about when the schema named one, and in a fixed banner
 * otherwise — which is why the field travels with the message rather than the
 * action throwing and replacing the half-filled form with an error boundary.
 */
export type ConsentActionState =
  | { status: "idle"; message: string }
  | {
      status: "error";
      message: string;
      /** The control a rejected submission is about, when one was named. */
      field?: string;
    };

export const initialConsentActionState: ConsentActionState = {
  message: "",
  status: "idle",
};

/**
 * The five controls this form draws, so a refusal naming any other value —
 * the sealed OAuth query, the client, the generated principal id — is global
 * in this form and stays in the banner rather than disappearing.
 */
export const consentFieldNames = [
  "agentPrincipalId",
  "displayName",
  "projectBinding",
  "slug",
  "softwareName",
] as const;

/** The principal option that means "create a new one from the three values". */
export const newAgentPrincipalValue = "new";
