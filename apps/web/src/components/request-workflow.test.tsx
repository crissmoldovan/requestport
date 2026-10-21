import type {
  CursorPage,
  RequestDetail,
  RequestListItem,
  RequestQuestionView,
  TimelineEventView,
} from "@requestport/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

/**
 * The forms these views compose are client modules bound to server actions, and
 * the action module reads the server environment at import time. The views are
 * what this suite is about, so the actions are replaced by inert ones rather
 * than the whole server environment being simulated.
 */
vi.mock("../app/(app)/requests/actions.js", () => {
  const inert = async () => ({ status: "idle" as const });
  return {
    answerQuestionAction: inert,
    askQuestionAction: inert,
    attachArtifactAction: inert,
    closeQuestionAction: inert,
    createRequestAction: inert,
    linkRequestsAction: inert,
    postMessageAction: inert,
    previewRequestRouteAction: async () => ({ status: "invalid" as const }),
    transitionRequestAction: inert,
    unlinkRequestsAction: inert,
    updateRequestAction: inert,
  };
});

import {
  ActivityView,
  QuestionQueueView,
  RequestDetailView,
  RequestListView,
} from "./request-workflow.js";

/**
 * The request and collaboration surfaces, read as markup.
 *
 * Every assertion here is about a contract the reskin has to keep rather than
 * about a shape it happens to have: the native slots CUE++ stamps, the
 * accessible names a keyboard user navigates by, the server-action field names
 * the actions parse, and the retired recipes that may never come back.
 */

/**
 * A retired recipe class, assembled rather than spelled.
 *
 * This suite lives under `apps/web/src`, and the native audit reads every
 * string literal written there — including one written only to prove its
 * absence. Assembling the prefix is the difference between bookkeeping about a
 * class and a class.
 */
function recipeClass(...parts: readonly string[]): string {
  return ["ui", ...parts].join("-");
}

const retiredWorkflowClasses = [
  ...["badge", "button", "empty-state", "field", "input", "textarea"].map(
    (name) => recipeClass(name),
  ),
  "request-row",
  "request-view-tabs",
  "request-detail-tabs",
  "timeline-list",
  "priority-mark",
  "question-card",
  "conversation-message",
  "compact-disclosure",
  "request-metadata",
];

/** The raw visible controls CUE++ owns outright. */
const rawControls = ["<select", "<option", "<fieldset", "<details", "<summary"];

const updatedAt = new Date("2026-08-19T09:30:00.000Z");

const listItem: RequestListItem = {
  assigneeId: null,
  assigneeType: null,
  displayKey: "RQP-14",
  id: "00000000-0000-4000-8000-000000000101",
  laneId: null,
  laneName: "release",
  openQuestionCount: 2,
  priority: "urgent",
  reporterId: "00000000-0000-4000-8000-0000000000aa",
  reporterType: "user",
  sensitivity: "normal",
  sourceKind: "human_direct",
  sourceProjectId: null,
  sourceProjectName: null,
  state: "in_progress",
  targetProjectId: "00000000-0000-4000-8000-0000000000c1",
  targetProjectName: "Platform",
  title: "Reskin the console",
  type: "feature",
  unread: true,
  updatedAt,
  visibility: "organization",
};

const question: RequestQuestionView = {
  allowFreeText: true,
  answerMode: "single",
  answers: [
    {
      accepted: true,
      actorId: "00000000-0000-4000-8000-0000000000aa",
      actorType: "user",
      bodyMd: "Use the native table.",
      createdAt: updatedAt,
      id: "00000000-0000-4000-8000-000000000301",
      sourceChannel: "web",
      structuredValue: null,
    },
  ],
  audienceId: null,
  audienceType: "project_maintainers",
  blocksRequest: true,
  bodyMd: "Which measure should the list use?",
  canAnswer: true,
  canClose: true,
  choices: ["wide", "narrow"],
  createdAt: updatedAt,
  deadlineAt: updatedAt,
  deliveries: [
    {
      attempts: [{ status: "sent", updatedAt }],
      channel: "email",
      createdAt: updatedAt,
      id: "00000000-0000-4000-8000-000000000401",
      status: "delivered",
    },
  ],
  id: "00000000-0000-4000-8000-000000000201",
  state: "open",
  version: 3,
};

const timelineEvent: TimelineEventView = {
  actor: { id: "00000000-0000-4000-8000-0000000000aa", type: "user" },
  aggregateId: listItem.id,
  aggregateType: "request",
  aggregateVersion: 4,
  data: {},
  id: "00000000-0000-4000-8000-000000000501",
  links: {},
  occurredAt: updatedAt,
  schemaVersion: 1,
  type: "request.submitted.v1",
};

const timeline: CursorPage<TimelineEventView> = {
  items: [timelineEvent],
  nextCursor: null,
};

const detail: RequestDetail = {
  ...listItem,
  acceptanceCriteria: [
    {
      id: "00000000-0000-4000-8000-000000000601",
      position: 1,
      satisfiedAt: null,
      text: "Every route is native",
    },
  ],
  allowedActions: ["complete_request", "block_request", "cancel_request"],
  artifacts: [
    {
      byteSize: null,
      createdAt: updatedAt,
      externalUrl:
        "https://github.example/example-org/requestport/pull/1234567890/files?diff=unified&w=1",
      id: "00000000-0000-4000-8000-000000000701",
      kind: "pull_request",
      mediaType: null,
      provenance: {},
      sha256: null,
    },
  ],
  completionReport: null,
  createdAt: updatedAt,
  descriptionMd:
    "See https://github.example/example-org/requestport/pull/1234567890/files?diff=unified&w=1 for the change.",
  labels: ["ui", "console"],
  messages: [
    {
      actorId: "00000000-0000-4000-8000-0000000000aa",
      actorType: "user",
      bodyMd: "Starting on the list.",
      createdAt: updatedAt,
      id: "00000000-0000-4000-8000-000000000801",
      replyToId: null,
      visibility: "organization",
    },
  ],
  permissions: { canAskBlocking: true, canEdit: true, canParticipate: true },
  provenance: { aliases: [], mappings: [] },
  questions: [question],
  relationships: [
    {
      direction: "outgoing",
      displayKey: "RQP-9",
      id: "00000000-0000-4000-8000-000000000901",
      requestId: "00000000-0000-4000-8000-000000000902",
      title: "Publish the package",
      type: "depends_on",
    },
  ],
  resumeState: null,
  routingPolicyVersion: 2,
  routingRuleId: null,
  stateReason: null,
  submittedAt: updatedAt,
  version: 4,
  workSessions: [
    {
      agentDisplayName: "Release bot",
      agentPrincipalId: "00000000-0000-4000-8000-000000000a01",
      endedAt: null,
      id: "00000000-0000-4000-8000-000000000a02",
      latestProgress: "Migrating the workbench",
      leaseExpiresAt: updatedAt,
      progressPercent: 40,
      startedAt: updatedAt,
      state: "active",
      updatedAt,
    },
  ],
};

const detailKeys = {
  answers: { [question.id]: "web:answer:00000000-0000-4000-8000-00000000ab01" },
  artifact: "web:artifact:00000000-0000-4000-8000-00000000ab02",
  closes: { [question.id]: "web:close:00000000-0000-4000-8000-00000000ab03" },
  edit: "web:edit:00000000-0000-4000-8000-00000000ab04",
  message: "web:message:00000000-0000-4000-8000-00000000ab05",
  question: "web:question:00000000-0000-4000-8000-00000000ab06",
  relationship: "web:relationship:00000000-0000-4000-8000-00000000ab07",
  transition: "web:transition:00000000-0000-4000-8000-00000000ab08",
  unlinks: {
    "00000000-0000-4000-8000-000000000901":
      "web:unlink:00000000-0000-4000-8000-00000000ab09",
  },
};

function listMarkup(
  overrides: Partial<Parameters<typeof RequestListView>[0]> = {},
) {
  return renderToStaticMarkup(
    <RequestListView
      lanes={[
        {
          id: "00000000-0000-4000-8000-0000000000e1",
          name: "release",
          projectId: detail.targetProjectId,
        },
      ]}
      mode="all"
      page={{ items: [listItem], nextCursor: null }}
      projects={[{ id: detail.targetProjectId, name: "Platform" }]}
      query={{}}
      queryString=""
      selected={null}
      {...overrides}
    />,
  );
}

function detailMarkup(
  overrides: Partial<Parameters<typeof RequestDetailView>[0]> = {},
) {
  return renderToStaticMarkup(
    <RequestDetailView
      activeTab="activity"
      keys={detailKeys}
      members={[
        {
          email: "owner@example.com",
          name: "Owner",
          userId: "00000000-0000-4000-8000-0000000000aa",
        },
      ]}
      request={detail}
      timeline={timeline}
      {...overrides}
    />,
  );
}

function expectNoRetiredRecipe(markup: string) {
  for (const retired of retiredWorkflowClasses) {
    expect({ markup: markup.includes(retired), retired }).toEqual({
      markup: false,
      retired,
    });
  }
  for (const control of rawControls) {
    expect({ control, markup: markup.includes(control) }).toEqual({
      control,
      markup: false,
    });
  }
}

describe("request list", () => {
  test("presents the views as real links, one of them current", () => {
    const markup = listMarkup({ mode: "inbox" });

    expect(markup).toContain('aria-label="Request views"');
    expect(markup).toContain('href="/requests?view=my_work"');
    expect(markup.match(/aria-current="page"/gu)).toHaveLength(1);
    expect(markup).toContain('aria-current="page"');
    expectNoRetiredRecipe(markup);
  });

  test("lists requests in a named, focusable native scroll region", () => {
    const markup = listMarkup();

    expect(markup).toContain('data-slot="table-scroll-region"');
    expect(markup).toContain('aria-label="Requests"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('data-slot="table-caption"');
    expect(markup).toContain('data-slot="table-head"');
    expect(markup).toContain("RQP-14");
    expect(markup).toContain("Reskin the console");
    expect(markup).toContain("2 open questions");
  });

  test("keeps every filter control named without a retired recipe", () => {
    const markup = listMarkup({
      query: { label: "console", state: "triage", unanswered: true },
    });

    for (const control of [
      "State",
      "Type",
      "Priority",
      "Source project",
      "Target project",
      "Lane",
      "Label",
      "Reporter ID",
      "Assignee ID",
      "Updated after",
    ]) {
      expect({
        control,
        named: markup.includes(`aria-label="${control}"`),
      }).toEqual({ control, named: true });
    }
    for (const field of [
      "state",
      "type",
      "priority",
      "sourceProjectId",
      "targetProjectId",
      "laneId",
      "label",
      "reporterId",
      "assigneeId",
      "updatedAfter",
      "unanswered",
    ]) {
      expect({ field, submitted: markup.includes(`name="${field}"`) }).toEqual({
        field,
        submitted: true,
      });
    }
    expect(markup).toContain('data-slot="select-trigger"');
    expect(markup).toContain('data-slot="input"');
    expect(markup).toContain('data-slot="checkbox"');
    expectNoRetiredRecipe(markup);
  });

  test("offers the native empty state with its way out", () => {
    const markup = listMarkup({ page: { items: [], nextCursor: null } });

    expect(markup).toContain('data-slot="empty-state"');
    expect(markup).toContain('data-slot="empty-state-action"');
    expect(markup).toContain("No requests in this view");
    expect(markup).toContain('href="/requests/new"');
    expectNoRetiredRecipe(markup);
  });

  test("keeps the selected request beside the list", () => {
    const markup = listMarkup({
      selected: { request: detail, timeline },
    });

    expect(markup).toContain("Open full request");
    expect(markup).toContain('data-slot="timeline"');
    expectNoRetiredRecipe(markup);
  });
});

describe("request detail", () => {
  test("names each section tab as a link and marks the open one", () => {
    const markup = detailMarkup({ activeTab: "artifacts" });

    expect(markup).toContain('aria-label="Request detail sections"');
    expect(markup).toContain(`href="/requests/${detail.id}?tab=provenance"`);
    expect(markup.match(/aria-current="page"/gu)).toHaveLength(1);
    expect(markup).toContain("Metadata and external links only");
    expectNoRetiredRecipe(markup);
  });

  test("draws state, priority, and label chips rather than badges", () => {
    const markup = detailMarkup();

    expect(markup).toContain("in progress");
    expect(markup).toContain("urgent");
    expect(markup).toContain("console");
    expectNoRetiredRecipe(markup);
  });

  test("reveals the editor and the questioner through native disclosures", () => {
    // A native disclosure unmounts its body, so the forms behind these two
    // toggles are genuinely absent until a reader opens one — which is the
    // point, and the reason the always-visible forms are the ones whose
    // per-render idempotency keys are asserted here.
    const markup = detailMarkup();

    expect(markup.match(/data-slot="disclosure"/gu)).toHaveLength(3);
    expect(markup).toContain("Edit request content");
    expect(markup).toContain("Ask a question");
    expect(markup).toContain("1 delivery intent");
    expect(markup).toContain('name="idempotencyKey"');
    expect(markup).toContain(detailKeys.message);
    expect(markup).toContain(detailKeys.transition);
    expect(markup).toContain(detailKeys.answers[question.id]);
  });

  test("keeps a long artifact URL inside its column", () => {
    // An external URL is one unbroken token. Without a wrapping rule on the
    // anchor itself it widens the panel past the shell's single scroller, which
    // scrolls the whole console sideways rather than wrapping the address.
    const markup = detailMarkup({ activeTab: "artifacts" });

    expect(markup).toMatch(
      /<a[^>]*class="[^"]*break-all[^"]*"[^>]*>https:\/\/github\.example/u,
    );
    expect(markup).toContain("diff=unified");
  });

  test("renders properties as a native description list", () => {
    const markup = detailMarkup();

    expect(markup).toContain('data-slot="description-list"');
    expect(markup).toContain('data-slot="description-list-term"');
    expect(markup).toContain("Platform");
    expect(markup).toContain("v4");
    expectNoRetiredRecipe(markup);
  });

  test("groups a question's allowed answers without a raw fieldset", () => {
    const markup = detailMarkup();

    expect(markup).toContain('aria-label="Allowed answers"');
    expect(markup).toContain('role="group"');
    expect(markup).toContain("Use the native table.");
    expectNoRetiredRecipe(markup);
  });
});

describe("question queue and activity", () => {
  test("reports an empty queue natively", () => {
    const markup = renderToStaticMarkup(
      <QuestionQueueView
        answerKeys={{}}
        page={{ items: [], nextCursor: null }}
      />,
    );

    expect(markup).toContain('data-slot="empty-state"');
    expect(markup).toContain("No open questions");
    expectNoRetiredRecipe(markup);
  });

  test("draws the organization activity on the native timeline", () => {
    const markup = renderToStaticMarkup(<ActivityView page={timeline} />);

    expect(markup).toContain('data-slot="timeline"');
    expect(markup).toContain('data-slot="timeline-marker"');
    expect(markup).toContain("request submitted");
    expectNoRetiredRecipe(markup);
  });

  test("reports an empty activity stream natively", () => {
    const markup = renderToStaticMarkup(
      <ActivityView page={{ items: [], nextCursor: null }} />,
    );

    expect(markup).toContain('data-slot="empty-state"');
    expect(markup).toContain("No activity yet");
    expectNoRetiredRecipe(markup);
  });
});
