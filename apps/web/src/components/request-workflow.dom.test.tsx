import { ThemeProvider } from "@cueplusplus/ui/system";
import type {
  CursorPage,
  RequestDetail,
  RequestListItem,
  RequestQuestionView,
  TimelineEventView,
} from "@requestport/domain";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";

/**
 * The forms the selected request draws are bound to server actions whose
 * module reads the server environment at import. The transition answers
 * success, so a case can put a result banner on screen.
 */
vi.mock("../app/(app)/requests/actions.js", () => {
  const inert = async () => ({ status: "idle" as const });
  return {
    answerQuestionAction: inert,
    askQuestionAction: inert,
    assignRequestAction: inert,
    attachArtifactAction: inert,
    closeQuestionAction: inert,
    createRequestAction: inert,
    linkRequestsAction: inert,
    postMessageAction: inert,
    previewRequestRouteAction: async () => ({ status: "invalid" as const }),
    transitionRequestAction: async () => ({
      message: "Request state updated.",
      status: "success" as const,
    }),
    unlinkRequestsAction: inert,
    updateRequestAction: inert,
  };
});

vi.mock("next/navigation", () => ({
  usePathname: () => "/requests",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  // Every case here has a request selected, so the address names one
  // (the shell closes it when `requestId` leaves the address, ruling 262).
  useSearchParams: () =>
    new URLSearchParams("requestId=00000000-0000-4000-8000-000000000101"),
}));

import { RequestListView } from "./request-workflow.js";

/**
 * Selecting another row changes `?requestId=` and nothing else, and the App
 * Router keeps the page's component instances across a change of search
 * parameters. Rerendering the same list with another selected request is that
 * navigation; every case here asks that the second request is drawn as if it
 * had been opened first.
 */

const updatedAt = new Date("2026-08-19T09:30:00.000Z");

const listItem: RequestListItem = {
  assigneeId: null,
  assigneeType: null,
  assigneeDisplayName: null,
  displayKey: "RQP-14",
  id: "00000000-0000-4000-8000-000000000101",
  laneId: null,
  laneName: null,
  openQuestionCount: 0,
  priority: "normal",
  reporterId: "00000000-0000-4000-8000-0000000000aa",
  reporterType: "user",
  reporterDisplayName: null,
  sensitivity: "normal",
  sourceKind: "human_direct",
  sourceProjectId: null,
  sourceProjectName: null,
  state: "submitted",
  targetProjectId: "00000000-0000-4000-8000-0000000000c1",
  targetProjectName: "Platform",
  title: "Request A",
  type: "feature",
  unread: false,
  updatedAt,
  visibility: "organization",
};

const base: RequestDetail = {
  ...listItem,
  acceptanceCriteria: [],
  allowedActions: [],
  artifacts: [],
  completionReport: null,
  createdAt: updatedAt,
  descriptionMd: "What the request asks for.",
  labels: [],
  messages: [],
  permissions: {
    canAssign: false,
    canAskBlocking: true,
    canEdit: true,
    canParticipate: true,
  },
  provenance: { aliases: [], mappings: [] },
  questions: [],
  relationships: [],
  resumeState: null,
  routingPolicyVersion: 1,
  routingRuleId: null,
  stateReason: null,
  submittedAt: updatedAt,
  version: 2,
  workSessions: [],
};

/** Submitted: its first next step is Begin triage, which needs no reason. */
const requestA: RequestDetail = {
  ...base,
  allowedActions: ["begin_triage", "withdraw_request", "cancel_request"],
  id: "00000000-0000-4000-8000-00000000aaaa",
  state: "submitted",
  title: "Request A",
};

/** In progress: its first next step is Complete, which draws the report. */
const requestB: RequestDetail = {
  ...base,
  allowedActions: ["complete_request", "block_request", "cancel_request"],
  id: "00000000-0000-4000-8000-00000000bbbb",
  state: "in_progress",
  title: "Request B",
};

const openQuestion: RequestQuestionView = {
  allowFreeText: true,
  answerMode: "single",
  answers: [],
  audienceId: null,
  audienceType: "project_maintainers",
  blocksRequest: true,
  bodyMd: "Which measure should the list use?",
  canAnswer: true,
  canClose: true,
  choices: [],
  createdAt: updatedAt,
  deadlineAt: null,
  deliveries: [],
  id: "00000000-0000-4000-8000-000000000201",
  state: "open",
  version: 1,
};

const timeline: CursorPage<TimelineEventView> = { items: [], nextCursor: null };

function list(selected: RequestDetail) {
  return (
    <ThemeProvider persistPreferences={false} theme="requestport">
      <RequestListView
        lanes={[]}
        mode="all"
        now={updatedAt}
        page={{ items: [listItem], nextCursor: null }}
        projects={[{ id: listItem.targetProjectId, name: "Platform" }]}
        query={{}}
        queryString=""
        selected={{
          keys: {
            answers: {
              [openQuestion.id]: `web:answer:${selected.id}`,
            },
            assign: `web:assign:${selected.id}`,
            transition: `web:transition:${selected.id}`,
          },
          request: selected,
          timeline,
        }}
      />
    </ThemeProvider>
  );
}

/** The transition the next-step form would submit. */
function submittedAction(container: HTMLElement) {
  return [
    ...container.querySelectorAll<HTMLInputElement>('input[name="action"]'),
  ].map((input) => input.value);
}

describe("selecting another request beside the list", () => {
  test("offers the new request's own next step, not the last one's", () => {
    const { container, rerender } = render(list(requestB));
    expect(submittedAction(container)).toEqual(["complete_request"]);
    expect(screen.getByRole("textbox", { name: "Outcome" })).toBeVisible();

    rerender(list(requestA));

    expect(
      screen.getByRole("heading", { level: 2, name: "Request A" }),
    ).toBeVisible();
    expect(submittedAction(container)).toEqual(["begin_triage"]);
    expect(
      screen.queryByRole("textbox", { name: "Outcome" }),
    ).not.toBeInTheDocument();
  });

  test("does not show the last request's result as the new one's", async () => {
    const user = userEvent.setup();
    const { rerender } = render(list(requestA));
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText("Request state updated.");

    rerender(list(requestB));

    expect(
      screen.getByRole("heading", { level: 2, name: "Request B" }),
    ).toBeVisible();
    expect(
      screen.queryByText("Request state updated."),
    ).not.toBeInTheDocument();
  });

  test("opens the new request on its questions when one is open", () => {
    const { rerender } = render(list(requestA));
    expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    rerender(list({ ...requestB, questions: [openQuestion] }));

    expect(screen.getByRole("tab", { name: "Questions (1)" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
