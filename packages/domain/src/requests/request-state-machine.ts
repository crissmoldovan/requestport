import { DomainError } from "../shared/errors.js";
import type {
  RequestAction,
  RequestState,
  ResumableRequestState,
} from "./request-types.js";

const fixedTransitions: Partial<
  Record<RequestAction, ReadonlyMap<RequestState, RequestState>>
> = {
  submit_request: new Map([["draft", "submitted"]]),
  begin_triage: new Map([["submitted", "triage"]]),
  accept_request: new Map([["triage", "accepted"]]),
  decline_request: new Map([["triage", "declined"]]),
  mark_duplicate: new Map([["triage", "duplicate"]]),
  supersede_request: new Map([["triage", "superseded"]]),
  plan_request: new Map([["accepted", "planned"]]),
  begin_request_work: new Map([
    ["accepted", "in_progress"],
    ["planned", "in_progress"],
  ]),
  withdraw_request: new Map([
    ["submitted", "cancelled"],
    ["triage", "cancelled"],
  ]),
  reopen_request: new Map([
    ["declined", "triage"],
    ["duplicate", "triage"],
    ["completed", "triage"],
    ["verified", "triage"],
  ]),
  complete_request: new Map([["in_progress", "completed"]]),
  verify_request: new Map([["completed", "verified"]]),
};

const blockableStates = new Set<RequestState>([
  "triage",
  "accepted",
  "planned",
  "in_progress",
]);
const cancellableStates = new Set<RequestState>([
  "submitted",
  "triage",
  "accepted",
  "planned",
  "in_progress",
  "blocked",
  "waiting_human",
  "waiting_requester",
]);

export function nextRequestState(input: {
  action: RequestAction;
  state: RequestState;
  resumeState?: ResumableRequestState | null;
}): { state: RequestState; resumeState: ResumableRequestState | null } {
  if (input.action === "block_request") {
    if (!blockableStates.has(input.state)) {
      throw new DomainError(
        "invalid_transition",
        "Request cannot be blocked from its current state",
      );
    }
    return {
      state: "blocked",
      resumeState: input.state as ResumableRequestState,
    };
  }
  if (input.action === "resume_request") {
    if (input.state !== "blocked" || !input.resumeState) {
      throw new DomainError(
        "invalid_transition",
        "Request has no valid blocked state to resume",
      );
    }
    return { state: input.resumeState, resumeState: null };
  }
  if (input.action === "cancel_request") {
    if (!cancellableStates.has(input.state)) {
      throw new DomainError(
        "invalid_transition",
        "Request cannot be cancelled from its current state",
      );
    }
    return { state: "cancelled", resumeState: null };
  }
  const next = fixedTransitions[input.action]?.get(input.state);
  if (!next) {
    throw new DomainError(
      "invalid_transition",
      "Request action is not valid for its current state",
    );
  }
  return { state: next, resumeState: null };
}
