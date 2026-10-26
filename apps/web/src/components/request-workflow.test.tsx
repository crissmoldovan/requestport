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
    assignRequestAction: inert,
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

/**
 * The workbench's client parts navigate with the App Router, which a static
 * render has no instance of. Nothing here clicks, so a router that records
 * nothing is enough for the markup to render. The address names a selected
 * request, as every address the page draws one for does: the shell keeps a
 * request open only while `requestId` is in it (ruling 262).
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/requests",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () =>
    new URLSearchParams("requestId=00000000-0000-4000-8000-000000000101"),
}));

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
  assigneeDisplayName: null,
  displayKey: "RQP-14",
  id: "00000000-0000-4000-8000-000000000101",
  laneId: null,
  laneName: "release",
  openQuestionCount: 2,
  priority: "urgent",
  reporterId: "00000000-0000-4000-8000-0000000000aa",
  reporterType: "user",
  reporterDisplayName: null,
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
      actorDisplayName: null,
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
      actorDisplayName: null,
      actorId: "00000000-0000-4000-8000-0000000000aa",
      actorType: "user",
      bodyMd: "Starting on the list.",
      createdAt: updatedAt,
      id: "00000000-0000-4000-8000-000000000801",
      replyToId: null,
      visibility: "organization",
    },
  ],
  permissions: {
    canAssign: false,
    canAskBlocking: true,
    canEdit: true,
    canParticipate: true,
  },
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
  assign: "web:assign:00000000-0000-4000-8000-00000000ab0a",
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

const lane = {
  id: "00000000-0000-4000-8000-0000000000e1",
  name: "release",
  projectId: detail.targetProjectId,
};

/** Two hours after the fixture's last update, so every row reads `2h`. */
const now = new Date(updatedAt.getTime() + 2 * 60 * 60 * 1000);

const selectedKeys = {
  answers: { [question.id]: "web:answer:00000000-0000-4000-8000-00000000ac01" },
  assign: "web:assign:00000000-0000-4000-8000-00000000ac03",
  transition: "web:transition:00000000-0000-4000-8000-00000000ac02",
};

function listMarkup(
  overrides: Partial<Parameters<typeof RequestListView>[0]> = {},
) {
  return renderToStaticMarkup(
    <RequestListView
      lanes={[lane]}
      mode="all"
      now={now}
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
      activeTab="relations"
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

/** Every opening tag of an element, by tag name, as the markup spells it. */
function openingTags(markup: string, tag: string): string[] {
  return markup.match(new RegExp(`<${tag}\\b[^>]*>`, "gu")) ?? [];
}

/** The opening tags of the links that are also tabs. */
function tabLinks(markup: string): string[] {
  return openingTags(markup, "a").filter((tag) => tag.includes('role="tab"'));
}

/** The attribute values a set of opening tags carries, in document order. */
function attributeValues(tags: string[], attribute: string): string[] {
  return tags.map(
    (tag) => tag.match(new RegExp(`${attribute}="([^"]*)"`, "u"))?.[1] ?? "",
  );
}

describe("request list", () => {
  test("draws the four views as cue-ui tabs that are links, one of them current", () => {
    const markup = listMarkup({ mode: "inbox" });
    const tabs = tabLinks(markup);

    expect(markup).toContain('aria-label="Request views"');
    expect(markup).toContain('role="tablist"');
    expect(attributeValues(tabs, "href")).toEqual([
      "/requests",
      "/requests?view=inbox",
      "/requests?view=my_work",
      "/requests?unanswered=true",
    ]);
    expect(tabs.filter((tag) => tag.includes('aria-current="page"'))).toEqual([
      expect.stringContaining('href="/requests?view=inbox"'),
    ]);
    expect(markup.match(/aria-current="page"/gu)).toHaveLength(1);
    expectNoRetiredRecipe(markup);
  });

  test("makes Waiting on an answer the view for unanswered requests", () => {
    const markup = listMarkup({
      query: { unanswered: true },
      queryString: "unanswered=true",
    });

    expect(
      tabLinks(markup).filter((tag) => tag.includes('aria-current="page"')),
    ).toEqual([expect.stringContaining('href="/requests?unanswered=true"')]);
    // The view is the filter, so it is not repeated as a chip.
    expect(markup).not.toContain('aria-label="Active filters"');
    // And it owns the parameter: every other view leaves `unanswered` behind,
    // or a reader in this view could not get out of it.
    expect(attributeValues(tabLinks(markup), "href")).toEqual([
      "/requests",
      "/requests?view=inbox",
      "/requests?view=my_work",
      "/requests?unanswered=true",
    ]);
  });

  test("keeps the filters in force when the reader changes view", () => {
    const markup = listMarkup({
      query: { state: "triage" },
      queryString: "state=triage",
    });

    expect(attributeValues(tabLinks(markup), "href")).toEqual([
      "/requests?state=triage",
      "/requests?state=triage&amp;view=inbox",
      "/requests?state=triage&amp;view=my_work",
      "/requests?state=triage&amp;unanswered=true",
    ]);
  });

  test("draws each active filter as a link that drops its own parameter", () => {
    const markup = listMarkup({
      mode: "inbox",
      query: {
        label: "console",
        state: "triage",
        targetProjectId: detail.targetProjectId,
        unanswered: true,
      },
      queryString: `view=inbox&state=triage&targetProjectId=${detail.targetProjectId}&label=console&unanswered=true`,
    });
    const chips = openingTags(markup, "a").filter((tag) =>
      tag.includes('aria-label="Remove filter '),
    );

    expect(markup).toContain('aria-label="Active filters"');
    expect(attributeValues(chips, "aria-label")).toEqual([
      "Remove filter State: Triage",
      "Remove filter To: Platform",
      "Remove filter Label: console",
      "Remove filter Has an open question",
    ]);
    expect(attributeValues(chips, "href")).toEqual([
      `/requests?view=inbox&amp;targetProjectId=${detail.targetProjectId}&amp;label=console&amp;unanswered=true`,
      "/requests?view=inbox&amp;state=triage&amp;label=console&amp;unanswered=true",
      `/requests?view=inbox&amp;state=triage&amp;targetProjectId=${detail.targetProjectId}&amp;unanswered=true`,
      `/requests?view=inbox&amp;state=triage&amp;targetProjectId=${detail.targetProjectId}&amp;label=console`,
    ]);
    expect(markup).toMatch(
      /<a[^>]*href="\/requests\?view=inbox"[^>]*>Clear all/u,
    );
    expect(markup).toContain("Filters (4)");
  });

  test("with every filter in force, draws eleven chips, each dropping exactly its own parameter", () => {
    const sourceProjectId = "00000000-0000-4000-8000-0000000000c3";
    const params = new URLSearchParams({
      view: "my_work",
      state: "blocked",
      type: "bug",
      priority: "low",
      sourceProjectId,
      targetProjectId: detail.targetProjectId,
      laneId: lane.id,
      label: "console",
      reporterId: "user-1",
      assigneeId: "user-7",
      updatedAfter: "2026-08-19",
      unanswered: "true",
    });
    const markup = listMarkup({
      mode: "my_work",
      projects: [
        { id: sourceProjectId, name: "Web" },
        { id: detail.targetProjectId, name: "Platform" },
      ],
      query: {
        assigneeId: "user-7",
        label: "console",
        laneId: lane.id,
        priority: "low",
        reporterId: "user-1",
        sourceProjectId,
        state: "blocked",
        targetProjectId: detail.targetProjectId,
        type: "bug",
        unanswered: true,
        updatedAfter: "2026-08-19",
      },
      queryString: params.toString(),
    });
    const chips = openingTags(markup, "a").filter((tag) =>
      tag.includes('aria-label="Remove filter '),
    );
    const inForce = [...params.keys()];
    // What each chip's address no longer carries, read from the address.
    const dropped = attributeValues(chips, "href").map((href) => {
      const kept = new URLSearchParams(
        href.replaceAll("&amp;", "&").split("?")[1] ?? "",
      );
      return inForce.filter((key) => !kept.has(key));
    });

    expect(dropped).toEqual([
      ["state"],
      ["type"],
      ["priority"],
      ["sourceProjectId"],
      ["targetProjectId"],
      ["laneId"],
      ["label"],
      ["reporterId"],
      ["assigneeId"],
      ["updatedAfter"],
      ["unanswered"],
    ]);
    expect(markup).toContain("Filters (11)");
  });

  test("keeps every filter field out of the page body, behind one Filters control", () => {
    const markup = listMarkup({
      query: { label: "console", state: "triage" },
      queryString: "state=triage&label=console",
    });

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
      expect({ field, inBody: markup.includes(`name="${field}"`) }).toEqual({
        field,
        inBody: false,
      });
    }
    expect(markup).not.toContain('aria-label="Request filters"');
    expect(markup).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>/u);
    expect(markup).toContain("Filters (2)");
    expectNoRetiredRecipe(markup);
  });

  test("lists requests as interactive rows: the title, one muted line, and the state chip", () => {
    const markup = listMarkup();
    const rows = openingTags(markup, "tr").filter((tag) =>
      tag.includes("cursor-pointer"),
    );

    expect(markup).toContain('data-slot="table-scroll-region"');
    expect(markup).toContain('aria-label="Requests"');
    expect(rows).toHaveLength(1);
    expect(markup).toMatch(
      /<a[^>]*href="\/requests\?requestId=00000000-0000-4000-8000-000000000101"[^>]*>Reskin the console<\/a>/u,
    );
    expect(markup).toContain('<span class="font-mono">RQP-14</span>');
    expect(markup).toContain(" · Feature · Urgent · ");
    expect(markup).toMatch(
      /<time [^>]*title="Updated 19 Aug 2026, 09:30"[^>]*>2h<\/time>/u,
    );
    expect(markup).toContain(" · 2 open questions");
    expect(markup).toContain(">In progress</span>");
    expect(markup).toContain(">Unread</span>");
    expectNoRetiredRecipe(markup);
  });

  test("offers the native empty state without a second New request", () => {
    const markup = listMarkup({ page: { items: [], nextCursor: null } });

    expect(markup).toContain('data-slot="empty-state"');
    expect(markup).toContain("No requests in this view");
    expect(markup.match(/href="\/requests\/new"/gu)).toHaveLength(1);
    expectNoRetiredRecipe(markup);
  });

  test("offers a way out of an empty filtered view", () => {
    const markup = listMarkup({
      mode: "my_work",
      page: { items: [], nextCursor: null },
      query: { priority: "urgent" },
      queryString: "view=my_work&priority=urgent",
    });

    expect(markup).toContain("Nothing matches these filters");
    expect(markup).toMatch(
      /data-slot="empty-state-action"[\s\S]*href="\/requests\?view=my_work"[^>]*>Clear filters/u,
    );
  });

  test("puts the list beside the selected request in a cue-ui split pane", () => {
    const markup = listMarkup({
      queryString: "view=inbox",
      selected: { keys: selectedKeys, request: detail, timeline },
    });

    expect(markup).toContain('data-slot="split-pane"');
    expect(markup).toContain('aria-label="Resize the requests"');
    expect(markup).not.toContain('data-slot="resizable-group"');
    expect(markup).toContain('aria-label="Request list"');
    expect(markup).toContain('aria-label="Selected request"');
    expect(markup).toMatch(/<tr[^>]*data-selected=""/u);
    expect(markup).toContain('aria-current="true"');
    // Selecting a row keeps the view and the filters it was chosen from.
    expect(markup).toMatch(
      new RegExp(
        `<a[^>]*href="/requests\\?view=inbox&amp;requestId=${listItem.id}"[^>]*>Reskin the console</a>`,
        "u",
      ),
    );
  });

  test("keeps the page of the list the reader is on when a row is selected or closed", () => {
    const markup = listMarkup({
      cursor: "c1",
      mode: "inbox",
      query: { state: "triage" },
      queryString: "view=inbox&state=triage",
      selected: { keys: selectedKeys, request: detail, timeline },
    });

    // The row and Close (the stacked Back goes to the same address) keep the
    // cursor, so the selected row is still on the page being read …
    expect(markup).toMatch(
      new RegExp(
        `<a[^>]*href="/requests\\?view=inbox&amp;state=triage&amp;cursor=c1&amp;requestId=${listItem.id}"[^>]*>Reskin the console</a>`,
        "u",
      ),
    );
    expect(markup).toMatch(
      /<a[^>]*aria-label="Close the request"[^>]*href="\/requests\?view=inbox&amp;state=triage&amp;cursor=c1"|<a[^>]*href="\/requests\?view=inbox&amp;state=triage&amp;cursor=c1"[^>]*aria-label="Close the request"/u,
    );
    // … while a view, a chip and Clear all choose another list, which starts
    // at its first page.
    expect(attributeValues(tabLinks(markup), "href")).toEqual([
      "/requests?state=triage",
      "/requests?state=triage&amp;view=inbox",
      "/requests?state=triage&amp;view=my_work",
      "/requests?state=triage&amp;unanswered=true",
    ]);
    expect(
      attributeValues(
        openingTags(markup, "a").filter((tag) =>
          tag.includes('aria-label="Remove filter '),
        ),
        "href",
      ),
    ).toEqual(["/requests?view=inbox"]);
    expect(markup).toMatch(
      /<a[^>]*href="\/requests\?view=inbox"[^>]*>Clear all/u,
    );
  });

  test("heads the selected request with its next step and three tabs", () => {
    const markup = listMarkup({
      queryString: "view=inbox",
      selected: { keys: selectedKeys, request: detail, timeline },
    });
    const tabs = openingTags(markup, "button").filter((tag) =>
      tag.includes('role="tab"'),
    );

    expect(markup).toMatch(
      /<h2[^>]*id="selected-request-title"[^>]*>Reskin the console<\/h2>/u,
    );
    expect(markup).toMatch(
      /<a[^>]*href="\/requests\/00000000-0000-4000-8000-000000000101"[^>]*>[\s\S]*?Open full record<\/a>/u,
    );
    expect(markup).toMatch(
      /<a[^>]*aria-label="Close the request"[^>]*href="\/requests\?view=inbox"|<a[^>]*href="\/requests\?view=inbox"[^>]*aria-label="Close the request"/u,
    );
    expect(markup).toContain(">Urgent priority</span>");
    expect(markup).toContain("Human direct → Platform / release");
    expect(markup).toContain(selectedKeys.transition);
    expect(tabs).toHaveLength(3);
    // An open question is what the reader came for, so its tab is the one open.
    expect(
      tabs.filter((tag) => tag.includes('aria-selected="true"')),
    ).toHaveLength(1);
    expect(markup).toContain("Questions (1)");
    expect(markup).toContain(selectedKeys.answers[question.id]);
    expect(markup).toContain('aria-label="Allowed answers"');
    expectNoRetiredRecipe(markup);
  });
});

/*
  Ruling 262: each view's count, people by name, and Assign beside the next
  step.
*/
describe("the workbench's follow-ups", () => {
  const members = [
    {
      email: "ada@example.com",
      name: "Ada Lovelace",
      userId: "00000000-0000-4000-8000-0000000000a1",
    },
  ];
  const named = {
    ...detail,
    assigneeDisplayName: "Ada Lovelace",
    assigneeId: "00000000-0000-4000-8000-0000000000a1",
    assigneeType: "user" as const,
    reporterDisplayName: "grace@example.com",
  };

  test("draws each view's count after its label", () => {
    const markup = listMarkup({
      counts: { all: 12, inbox: 3, my_work: 0, waiting: 5 },
    });

    expect(
      tabLinks(markup).map(
        (tag) =>
          markup
            .slice(markup.indexOf(tag) + tag.length)
            .split("</a>")[0]
            ?.replace(/<[^>]+>/gu, "") ?? "",
      ),
    ).toEqual(["All 12", "Inbox 3", "My work 0", "Waiting on an answer 5"]);
    // Without counts the tabs carry their labels alone.
    expect(listMarkup()).not.toContain('<span class="text-fg-muted"> ');
  });

  test("names the reporter and the assignee in the selected request's details and the record's Inspector, else the short id", () => {
    // With no open question the Details tab is the one drawn.
    const preview = listMarkup({
      members,
      selected: {
        keys: selectedKeys,
        request: { ...named, questions: [] },
        timeline,
      },
    });
    expect(preview).toMatch(
      /Assignee<\/dt><dd[^>]*>Ada Lovelace<\/dd>[\s\S]*Reporter<\/dt><dd[^>]*>grace@example\.com<\/dd>/u,
    );
    const record = detailMarkup({ request: named });
    for (const [label, value] of [
      ["Assignee", "Ada Lovelace"],
      ["Reporter", "grace@example.com"],
    ]) {
      expect(record).toMatch(
        new RegExp(
          `inspector-row-label"[^>]*>${label}</span><div data-slot="inspector-row-control"[^>]*>${value.replace(".", "\\.")}</div>`,
          "u",
        ),
      );
    }
    // A reporter the member list cannot name keeps the short id.
    expect(detailMarkup()).toMatch(
      /inspector-row-label"[^>]*>Reporter<\/span><div data-slot="inspector-row-control"[^>]*>user:00000000-000<\/div>/u,
    );
    expect(detailMarkup()).toMatch(
      /inspector-row-label"[^>]*>Assignee<\/span><div data-slot="inspector-row-control"[^>]*>Unassigned<\/div>/u,
    );
  });

  test("offers Assign beside the next step, on the record and in the workbench, only to a reader who may assign", () => {
    const assignable = {
      ...named,
      permissions: { ...named.permissions, canAssign: true },
    };
    const record = detailMarkup({ members, request: assignable });
    const aside = record.slice(
      record.indexOf('aria-label="Request properties"'),
    );
    const nextStep = aside.slice(0, aside.indexOf('data-slot="inspector"'));
    expect(nextStep).toContain(detailKeys.transition);
    expect(nextStep).toContain('aria-label="Assign request"');
    expect(nextStep).toContain(detailKeys.assign);
    expect(nextStep).toMatch(/>Assign<\/button>|>Assign<\/span>/u);

    const preview = listMarkup({
      members,
      selected: { keys: selectedKeys, request: assignable, timeline },
    });
    const header = preview.slice(
      preview.indexOf('id="selected-request-title"'),
      preview.indexOf(
        'role="tablist"',
        preview.indexOf("selected-request-title"),
      ),
    );
    expect(header).toContain(selectedKeys.transition);
    expect(header).toContain('aria-label="Assign request"');
    expect(header).toContain(selectedKeys.assign);

    // Without the permission, neither surface draws the form.
    expect(detailMarkup({ members, request: named })).not.toContain(
      'aria-label="Assign request"',
    );
    expect(
      listMarkup({
        members,
        selected: { keys: selectedKeys, request: named, timeline },
      }),
    ).not.toContain('aria-label="Assign request"');
    expectNoRetiredRecipe(record);
    expectNoRetiredRecipe(preview);
  });
});

describe("request record", () => {
  test("opens on a breadcrumb back to the list", () => {
    const markup = detailMarkup();

    expect(markup).toContain('data-slot="breadcrumb"');
    expect(markup).toMatch(/<a[^>]*href="\/requests"[^>]*>Requests<\/a>/u);
    expect(markup).toMatch(/aria-current="page"[^>]*>RQP-14</u);
  });

  test("keeps the record's sections in the article, each a heading", () => {
    const markup = detailMarkup();

    expect(markup).toMatch(
      /<h1[^>]*id="request-title"[^>]*>Reskin the console<\/h1>/u,
    );
    for (const title of [
      "Description",
      "Acceptance criteria",
      "Questions",
      "Activity",
      "Linked work",
    ]) {
      expect({
        heading: new RegExp(
          `<span aria-level="2"[^>]*role="heading">${title}</span>`,
          "u",
        ).test(markup),
        title,
      }).toEqual({ heading: true, title });
    }
    expect(markup).toContain(detailKeys.message);
    expect(markup).toContain("Starting on the list.");
    expect(markup).toContain('data-slot="timeline"');
  });

  test("keeps the next step and the properties in the aside", () => {
    const markup = detailMarkup();
    const aside = markup.slice(
      markup.indexOf('aria-label="Request properties"'),
    );

    expect(aside).toContain("Next step");
    expect(aside).toContain(detailKeys.transition);
    expect(aside).toContain('data-slot="inspector"');
    for (const label of [
      "State",
      "Assignee",
      "Priority",
      "From",
      "To",
      "Lane",
      "Labels",
      "Visibility",
      "ID",
    ]) {
      expect({
        label,
        row: aside.includes(
          `<span data-slot="inspector-row-label" class="text-(length:--cue-text-ui) text-fg-muted">${label}</span>`,
        ),
      }).toEqual({ label, row: true });
    }
    expect(aside).toContain("ui, console");
    expect(aside).toContain(detail.id);
    expect(aside).toContain("v4");
    expectNoRetiredRecipe(markup);
  });

  test("lists every delivery of the request's questions in the aside", () => {
    const markup = detailMarkup();
    const aside = markup.slice(
      markup.indexOf('aria-label="Request properties"'),
    );

    expect(aside).toContain("Deliveries");
    expect(aside).toContain(">email</span>");
    expect(aside).toContain("sent");
    expect(aside).toContain("delivered");
  });

  test("says which question each delivery in the aside was for", () => {
    const second: RequestQuestionView = {
      ...question,
      answers: [],
      bodyMd: "Should the record keep its tabs?",
      deliveries: [
        {
          attempts: [{ status: "failed", updatedAt }],
          channel: "slack",
          createdAt: updatedAt,
          id: "00000000-0000-4000-8000-000000000402",
          status: "failed",
        },
      ],
      id: "00000000-0000-4000-8000-000000000202",
    };
    const markup = detailMarkup({
      request: { ...detail, questions: [question, second] },
    });
    const aside = markup.slice(
      markup.indexOf('aria-label="Request properties"'),
    );

    // Each question's deliveries sit under what that question asked.
    expect(aside).toMatch(
      new RegExp(
        [
          ">Which measure should the list use\\?</span>",
          ">email</span>",
          ">Should the record keep its tabs\\?</span>",
          ">slack</span>",
        ].join("[\\s\\S]*"),
        "u",
      ),
    );
    expect(aside.match(/>email<\/span>/gu)).toHaveLength(1);
    expect(aside.match(/>slack<\/span>/gu)).toHaveLength(1);
    // Not a link to the delivery record, which members cannot open.
    expect(aside).not.toContain("/deliveries");
  });

  test("draws each open question as a card around the existing answer form", () => {
    const markup = detailMarkup();

    expect(markup).toContain(">Blocking</span>");
    expect(markup).toContain('aria-label="Allowed answers"');
    expect(markup).toContain('role="group"');
    expect(markup).toContain("Use the native table.");
    expect(markup).toContain(detailKeys.answers[question.id]);
    expect(markup).toContain('name="idempotencyKey"');
    expectNoRetiredRecipe(markup);
  });

  test("names each linked-work section as a link tab and marks the open one", () => {
    const markup = detailMarkup({ activeTab: "artifacts" });

    expect(markup).toContain('aria-label="Request detail sections"');
    expect(attributeValues(tabLinks(markup), "href")).toEqual([
      `/requests/${detail.id}?tab=relations`,
      `/requests/${detail.id}?tab=artifacts`,
      `/requests/${detail.id}?tab=sessions`,
      `/requests/${detail.id}?tab=provenance`,
    ]);
    expect(markup.match(/aria-current="page"/gu)).toHaveLength(2);
    expect(
      tabLinks(markup).filter((tag) => tag.includes('aria-current="page"')),
    ).toEqual([expect.stringContaining("?tab=artifacts")]);
    expect(markup).toContain("Metadata and external links only");
    expectNoRetiredRecipe(markup);
  });

  test("draws state as a chip, priority and type as tags, and the labels in the Inspector", () => {
    const markup = detailMarkup();

    expect(markup).toContain(">In progress</span>");
    expect(markup).toContain(">Urgent priority</span>");
    expect(markup).toContain(">Feature</span>");
    // The labels are a property, not a tag: the Inspector's Labels row.
    expect(markup).toMatch(
      /data-slot="inspector-row-label"[^>]*>Labels<\/span><div data-slot="inspector-row-control"[^>]*>ui, console<\/div>/u,
    );
    expectNoRetiredRecipe(markup);
  });

  test("reveals the editor, the questioner and the linker through native disclosures", () => {
    // A native disclosure unmounts its body, so the forms behind these
    // toggles are genuinely absent until a reader opens one — which is the
    // point, and the reason the always-visible forms are the ones whose
    // per-render idempotency keys are asserted here.
    const markup = detailMarkup();

    expect(markup.match(/data-slot="disclosure"/gu)).toHaveLength(3);
    expect(markup).toContain("Edit request content");
    expect(markup).toContain("Ask a question");
    expect(markup).toContain("Link another request");
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

  test("draws each open question as the record's card, headed by a link to its request", () => {
    const answerKey = "web:answer:00000000-0000-4000-8000-00000000ad01";
    const markup = renderToStaticMarkup(
      <QuestionQueueView
        answerKeys={{ [question.id]: answerKey }}
        page={{
          items: [
            {
              ...question,
              displayKey: "RQP-14",
              requestId: detail.id,
              title: "Reskin the console",
            },
          ],
          nextCursor: null,
        }}
      />,
    );

    expect(markup).toMatch(
      new RegExp(`<a[^>]*href="/requests/${detail.id}"[^>]*>`, "u"),
    );
    expect(markup).toContain(">RQP-14</span>");
    expect(markup).toContain(">Blocking</span>");
    expect(markup).toContain('aria-label="Allowed answers"');
    expect(markup).toContain(answerKey);
    // The card's own line: when it was asked, by when, and how it is answered —
    // the same line the record's card draws.
    expect(markup).toContain(
      "Asked 19 Aug 2026, 09:30 · due 19 Aug 2026, 09:30 · Free-text answers allowed",
    );
    // An answer already given is shown on the card, by whom.
    expect(markup).toContain("Use the native table.");
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

/*
  Ruling 264: an agent is named where the record showed its short id — the
  reporter, the author of a message or an answer — and a timeline event names
  its actor where the read found a name.
*/
describe("agents by name", () => {
  const agentId = "00000000-0000-4000-8000-0000000000b7";
  const byAgent = {
    ...detail,
    reporterDisplayName: "Triage bot",
    reporterId: agentId,
    reporterType: "agent" as const,
    messages: detail.messages.map((message) => ({
      ...message,
      actorDisplayName: "Triage bot",
      actorId: agentId,
      actorType: "agent",
    })),
    questions: [
      {
        ...question,
        answers: question.answers.map((answer) => ({
          ...answer,
          actorDisplayName: "Triage bot",
          actorId: agentId,
          actorType: "agent",
        })),
      },
    ],
  };
  const namedTimeline = {
    items: [
      {
        ...timelineEvent,
        actor: { id: agentId, type: "agent" },
        actorDisplayName: "Triage bot",
      },
    ],
    nextCursor: null,
  };

  test("names the agent as reporter, as a message's and an answer's author, and as an event's actor", () => {
    const record = detailMarkup({ request: byAgent, timeline: namedTimeline });
    expect(record).toMatch(
      /inspector-row-label"[^>]*>Reporter<\/span><div data-slot="inspector-row-control"[^>]*>Triage bot<\/div>/u,
    );
    expect(record).not.toContain(`agent:${agentId.slice(0, 12)}`);
    // The message's and the answer's author, each in the muted face.
    expect(
      record.match(
        /<span class="text-\(length:--cue-text-ui\) text-fg-muted">Triage bot<\/span>/gu,
      ),
    ).toHaveLength(2);
    expect(record).toContain(">Triage bot · v4 · <time");
  });

  test("falls back to the short id, and to the actor's type, where nothing was named", () => {
    const record = detailMarkup();
    expect(record).toContain(
      '<span class="font-mono text-(length:--cue-text-ui) text-fg-muted">user:00000000-000</span>',
    );
    expect(record).toContain(">user · v4 · <time");
  });
});

/*
  Ruling 264: the filter sheet offers the members as reporter and assignee,
  and a person filter's chip names whom it filters to.
*/
describe("people in the filters", () => {
  const members = [
    {
      email: "ada@example.com",
      name: "Ada Lovelace",
      userId: "00000000-0000-4000-8000-0000000000a1",
    },
  ];

  test("names a member's chip, an agent's from the row that names it, and anyone else's by the short id", () => {
    const agentId = "00000000-0000-4000-8000-0000000000b7";
    const markup = listMarkup({
      members,
      page: {
        items: [
          {
            ...listItem,
            assigneeDisplayName: "Triage bot",
            assigneeId: agentId,
            assigneeType: "agent",
          },
        ],
        nextCursor: null,
      },
      query: { assigneeId: agentId, reporterId: members[0]?.userId },
      queryString: `reporterId=${members[0]?.userId}&assigneeId=${agentId}`,
    });
    expect(markup).toContain(
      'aria-label="Remove filter Reporter: Ada Lovelace"',
    );
    expect(markup).toContain('aria-label="Remove filter Assignee: Triage bot"');

    const unknown = listMarkup({
      members,
      query: { reporterId: "user_nobody_listed" },
      queryString: "reporterId=user_nobody_listed",
    });
    expect(unknown).toContain(
      'aria-label="Remove filter Reporter: user_nobody_"',
    );
  });
});
