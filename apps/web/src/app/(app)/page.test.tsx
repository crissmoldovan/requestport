import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

/*
  The overview (ruling 258): a setup checklist while a step is open, a band of
  figures, what needs the person and recent activity — every figure and row
  from a query, so each case below sets what the queries answer and reads
  what the page draws from it.
*/

const reads = vi.hoisted(() => ({
  activity: vi.fn(),
  agents: vi.fn(),
  allActivity: vi.fn(),
  /** The `requestport.setup_card_hidden` cookie the request carries. */
  cookie: undefined as string | undefined,
  failed: vi.fn(),
  health: vi.fn(),
  organization: null as {
    id: string;
    name: string;
    role: string;
    slug: string;
  } | null,
  questions: vi.fn(),
  summary: vi.fn(),
  triage: vi.fn(),
}));

// Two reads the overview does not make are mocked too, so that a page which
// made them would render and the cases below would catch it: the agent list,
// whose session count includes paused, blocked and stale sessions, and the
// activity page's unfiltered read, which carries the appearance trigger's
// bookkeeping event.
vi.mock("@requestport/db", () => ({
  createAgentManagementRepository: () => ({ listAgents: reads.agents }),
  createOverviewQueryRepository: () => ({
    health: reads.health,
    listFailedDeliveries: reads.failed,
    listRecentActivity: reads.activity,
    listTriageRequests: reads.triage,
    summary: reads.summary,
  }),
  createRequestQueryRepository: () => ({
    listOpenQuestions: reads.questions,
    listOrganizationActivity: reads.allActivity,
  }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "requestport.setup_card_hidden" && reads.cookie !== undefined
        ? { name, value: reads.cookie }
        : undefined,
  }),
}));

// The setup card's Hide and Show, which `overview-actions.test.ts` drives.
vi.mock("./overview-actions.js", () => ({
  hideSetupCardAction: async () => {},
  showSetupCardAction: async () => {},
}));

vi.mock("../../lib/server-request-port.js", () => ({
  webStorage: () => ({ db: {} }),
}));

vi.mock("../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization: reads.organization,
    session: { user: { id: "user_owner" } },
  }),
}));

import OverviewPage from "./page.js";

const organizationId = "00000000-0000-4000-8000-0000000000d1";

const nothingSetUp = {
  agent: false,
  project: false,
  routing: false,
  team: false,
};

function summary(overrides: Record<string, unknown> = {}) {
  return {
    activeAgents: 0,
    connectedAgents: 0,
    failedDeliveries: 0,
    oldestQuestionAt: null,
    openRequests: 0,
    questionsForYou: 0,
    role: "owner",
    setup: nothingSetUp,
    ...overrides,
  };
}

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60 * 1000);

/** When the health read ran, by the database's clock. */
const checkedAt = new Date("2026-10-25T20:31:05.000Z");
const minutesBeforeCheck = (minutes: number) =>
  new Date(checkedAt.getTime() - minutes * 60 * 1000);

/** What the health read answers when the worker keeps up. */
function health(overrides: Record<string, unknown> = {}) {
  return {
    checkedAt,
    deadLetters: 0,
    lastDispatchAt: minutesBeforeCheck(3),
    oldestUnprocessedAt: null,
    unprocessedEvents: 0,
    ...overrides,
  };
}

/** The first event an organization has: the appearance trigger's, not a person's. */
const bookkeepingEvent = {
  actor: { id: "requestport-appearance-default-initializer", type: "service" },
  aggregateId: "00000000-0000-4000-8000-0000000000e1",
  aggregateType: "organization_appearance",
  aggregateVersion: 1,
  data: {},
  id: "event_bookkeeping",
  links: {},
  occurredAt: minutesAgo(1),
  schemaVersion: 1,
  type: "appearance.organization_defaults_initialized.v1",
};

async function markup() {
  return renderToStaticMarkup((await OverviewPage()) as ReactElement);
}

/** The text a fragment of markup reads as, tags removed. */
function text(html: string) {
  return html.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");
}

beforeEach(() => {
  reads.organization = {
    id: organizationId,
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  };
  reads.cookie = undefined;
  for (const read of [
    reads.activity,
    reads.agents,
    reads.allActivity,
    reads.failed,
    reads.health,
    reads.questions,
    reads.summary,
    reads.triage,
  ]) {
    read.mockReset();
  }
  reads.summary.mockResolvedValue(summary());
  reads.health.mockResolvedValue(health());
  reads.agents.mockResolvedValue([]);
  reads.questions.mockResolvedValue({ items: [], nextCursor: null });
  reads.triage.mockResolvedValue([]);
  reads.failed.mockResolvedValue([]);
  reads.activity.mockResolvedValue([]);
  // What the activity page reads for an organization nobody has used yet.
  reads.allActivity.mockResolvedValue({
    items: [bookkeepingEvent],
    nextCursor: null,
  });
});

/**
 * The titles of the setup card's items that show "Done": the markup split at
 * each `Item`, keeping the ones whose media is the Done chip.
 */
function doneSteps(html: string) {
  return html
    .split('data-slot="item"')
    .slice(1)
    .filter((item) => item.includes(">Done</span>"))
    .map((item) => /data-slot="item-title"[^>]*>([^<]+)</u.exec(item)?.[1]);
}

describe("the overview of an empty organization", () => {
  test("shows the setup card with nothing done, each step linking to the page that does it", async () => {
    const html = await markup();

    expect(html).toContain("Finish setting up RequestPort");
    expect(html).toContain("0 of 4 done");
    expect(html).toContain('data-slot="progress"');
    for (const [step, href] of [
      ["Create a project", "/settings/projects/new"],
      ["Connect an agent", "/agents"],
      ["Invite your team", "/settings/members"],
      ["Decide who can ask whom", "/settings/routing"],
    ]) {
      expect(html).toContain(step);
      expect(html).toContain(`href="${href}"`);
    }
  });

  test("reads zero in every figure, and plain empty states below", async () => {
    const html = await markup();
    const band = text(html);

    expect(html).toContain('data-slot="stat-band"');
    expect(band).toMatch(/Open requests\s+0/u);
    expect(band).toMatch(/Waiting on your answer\s+0/u);
    expect(band).toMatch(/Agents connected, 24 h\s+0\s+Of 0 registered/u);
    expect(band).toMatch(/Failed deliveries, 24 h\s+0/u);
    expect(html).toContain("Nothing needs you");
    // The organization's one event is the appearance trigger's bookkeeping,
    // which the overview's activity read leaves out (the db suite's
    // first-run cases), so the panel is empty.
    expect(html).toContain("No activity yet");
    expect(html).not.toContain("appearance");
    expect(html.match(/data-slot="empty-state"/gu)).toHaveLength(2);
  });

  test("asks each read for this person and this organization", async () => {
    await markup();

    expect(reads.summary).toHaveBeenCalledWith("user_owner", organizationId);
    expect(reads.triage).toHaveBeenCalledWith(
      "user_owner",
      organizationId,
      expect.any(Number),
    );
    expect(reads.failed).toHaveBeenCalledWith(
      "user_owner",
      organizationId,
      expect.any(Number),
    );
    expect(reads.questions).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId, userId: "user_owner" }),
    );
    expect(reads.activity).toHaveBeenCalledWith(
      "user_owner",
      organizationId,
      expect.any(Number),
    );
    expect(reads.health).toHaveBeenCalledWith("user_owner", organizationId);
    expect(reads.agents).not.toHaveBeenCalled();
    expect(reads.allActivity).not.toHaveBeenCalled();
  });
});

describe("the setup card", () => {
  test("marks a finished step done and counts it", async () => {
    reads.summary.mockResolvedValue(
      summary({ setup: { ...nothingSetUp, agent: true, project: true } }),
    );
    const html = await markup();

    expect(html).toContain("2 of 4 done");
    expect(doneSteps(html)).toEqual(["Create a project", "Connect an agent"]);
  });

  test.each([
    ["project", "Create a project"],
    ["agent", "Connect an agent"],
    ["team", "Invite your team"],
    ["routing", "Decide who can ask whom"],
  ])("marks only the step its own figure finishes: %s", async (flag, title) => {
    reads.summary.mockResolvedValue(
      summary({ setup: { ...nothingSetUp, [flag]: true } }),
    );
    const html = await markup();

    expect(html).toContain("1 of 4 done");
    expect(doneSteps(html)).toEqual([title]);
  });

  test("disappears once all four steps are done", async () => {
    reads.summary.mockResolvedValue(
      summary({
        setup: { agent: true, project: true, routing: true, team: true },
      }),
    );
    const html = await markup();

    expect(html).not.toContain("Finish setting up RequestPort");
    expect(html).not.toContain('data-slot="progress"');
  });

  test("is not shown to a member, who can do none of its steps", async () => {
    reads.organization = {
      id: organizationId,
      name: "CUE++",
      role: "member",
      slug: "example-org",
    };
    reads.summary.mockResolvedValue(
      summary({ failedDeliveries: null, role: "member" }),
    );
    const html = await markup();

    expect(html).not.toContain("Finish setting up RequestPort");
  });
});

describe("the figures", () => {
  test("print what the queries counted", async () => {
    reads.summary.mockResolvedValue(
      summary({
        activeAgents: 2,
        failedDeliveries: 1,
        oldestQuestionAt: minutesAgo(90),
        openRequests: 23,
        questionsForYou: 2,
        connectedAgents: 1,
      }),
    );
    const band = text(await markup());

    expect(band).toMatch(/Open requests\s+23/u);
    expect(band).toMatch(
      /Waiting on your answer\s+2\s+Oldest asked 2 hours ago/u,
    );
    expect(band).toMatch(/Agents connected, 24 h\s+1\s+Of 2 registered/u);
    expect(band).toMatch(/Failed deliveries, 24 h\s+1/u);
    expect(band).not.toContain("Agents registered");
  });

  test("count the agents that signed in within a day, not the ones registered (ruling 261)", async () => {
    reads.summary.mockResolvedValue(
      summary({ activeAgents: 3, connectedAgents: 0 }),
    );
    const band = text(await markup());

    expect(band).toMatch(/Agents connected, 24 h\s+0\s+Of 3 registered/u);
  });

  test("leave failed deliveries out for a member, who cannot see webhooks", async () => {
    reads.organization = {
      id: organizationId,
      name: "CUE++",
      role: "member",
      slug: "example-org",
    };
    reads.summary.mockResolvedValue(
      summary({ failedDeliveries: null, role: "member" }),
    );
    const html = await markup();

    expect(html).not.toContain("Failed deliveries");
    expect(text(html)).toMatch(/Open requests\s+0/u);
  });
});

describe("what needs you", () => {
  test("lists questions, triage and failed deliveries newest first, each linking to its page", async () => {
    reads.summary.mockResolvedValue(summary({ questionsForYou: 1 }));
    reads.questions.mockResolvedValue({
      items: [
        {
          bodyMd: "Quote line breaks too?\nOr replace them with spaces?",
          createdAt: minutesAgo(60),
          displayKey: "RP-142",
          id: "question_1",
          requestId: "request_142",
          title: "CSV export",
        },
      ],
      nextCursor: null,
    });
    reads.triage.mockResolvedValue([
      {
        displayKey: "RP-141",
        id: "request_141",
        state: "submitted",
        targetProjectName: "auth",
        title: "SAML single sign-on",
        updatedAt: minutesAgo(18),
      },
    ]);
    reads.failed.mockResolvedValue([
      {
        eventType: "request.completed",
        failedAt: minutesAgo(40),
        id: "delivery_7",
        subscriptionId: "subscription_7",
        subscriptionName: "billing-events",
      },
    ]);
    const html = await markup();

    // A question is answered on its request's page, as /questions links it.
    // The three lists are joined question, triage, delivery; the question is
    // the oldest (60 minutes), so newest first reads triage (18), delivery
    // (40), question.
    const question = html.indexOf('href="/requests/request_142"');
    const triage = html.indexOf('href="/requests/request_141"');
    const delivery = html.indexOf('href="/webhooks/subscription_7"');
    expect(triage).toBeGreaterThan(-1);
    expect(delivery).toBeGreaterThan(triage);
    expect(question).toBeGreaterThan(delivery);
    expect(html).not.toContain("/questions/question_1");
    expect(html).toContain("Quote line breaks too?");
    expect(html).not.toContain("Or replace them with spaces?");
    expect(html).toContain("SAML single sign-on");
    expect(html).toContain("billing-events");
    for (const kind of ["Question", "Triage", "Delivery"]) {
      expect(html).toContain(`>${kind}</span>`);
    }
    expect(html).toContain('href="/requests?view=inbox"');
    expect(html).not.toContain("Nothing needs you");
  });
});

describe("recent activity", () => {
  test("draws the organization's latest events as a timeline linking to Activity", async () => {
    reads.activity.mockResolvedValue([
      {
        actor: { type: "agent" },
        aggregateId: "request_142",
        aggregateType: "request",
        aggregateVersion: 4,
        data: {},
        id: "event_1",
        links: {},
        occurredAt: minutesAgo(12),
        schemaVersion: 1,
        type: "question.asked",
      },
      {
        actor: { type: "user" },
        aggregateId: "request_137",
        aggregateType: "request",
        aggregateVersion: 9,
        data: {},
        id: "event_2",
        links: {},
        occurredAt: minutesAgo(120),
        schemaVersion: 1,
        type: "request.completed",
      },
    ]);
    const html = await markup();

    expect(html).toContain('data-slot="timeline"');
    expect(html).toContain("question asked");
    expect(html).toContain("request completed");
    expect(html).toContain('href="/activity"');
    expect(html).not.toContain("No activity yet");
  });
});

describe("hiding the setup card (ruling 261)", () => {
  const otherOrganization = "00000000-0000-4000-8000-0000000000d2";

  test("offers Hide in the card's footer, as a form that posts it", async () => {
    const html = await markup();
    const footer = html.slice(html.indexOf('data-slot="card-footer"'));

    expect(html).toContain('data-slot="card-footer"');
    expect(footer).toMatch(
      /^[\s\S]*?<form[^>]*>[\s\S]*?<button[^>]*type="submit"/u,
    );
    expect(text(footer)).toMatch(/^[^<]*?Hide\b/u);
  });

  test("renders the page without the card for the person who hid it there, with a way to bring it back", async () => {
    reads.cookie = `${organizationId}:user_owner`;
    reads.summary.mockResolvedValue(
      summary({ setup: { ...nothingSetUp, project: true } }),
    );
    const html = await markup();

    expect(html).not.toContain("Finish setting up RequestPort");
    expect(html).not.toContain('data-slot="progress"');
    expect(text(html)).toContain("Setup: 1 of 4 steps done.");
    expect(html).toMatch(
      /<form[^>]*>[\s\S]*?<button[^>]*type="submit"[^>]*>[\s\S]*?Show setup steps/u,
    );
  });

  test("still shows the card when someone else hid theirs, or this person hid it in another organization", async () => {
    reads.cookie = `${organizationId}:user_other|${otherOrganization}:user_owner`;
    const html = await markup();

    expect(html).toContain("Finish setting up RequestPort");
    expect(html).not.toContain("Show setup steps");
  });

  test("offers no way back once every step is done", async () => {
    reads.cookie = `${organizationId}:user_owner`;
    reads.summary.mockResolvedValue(
      summary({
        setup: { agent: true, project: true, routing: true, team: true },
      }),
    );
    const html = await markup();

    expect(html).not.toContain("Finish setting up RequestPort");
    expect(html).not.toContain("Show setup steps");
  });

  test("shows a member neither the card nor the way back", async () => {
    reads.organization = {
      id: organizationId,
      name: "CUE++",
      role: "member",
      slug: "example-org",
    };
    reads.summary.mockResolvedValue(
      summary({ failedDeliveries: null, role: "member" }),
    );
    for (const cookie of [undefined, `${organizationId}:user_owner`]) {
      reads.cookie = cookie;
      const html = await markup();

      expect(html).not.toContain("Finish setting up RequestPort");
      expect(html).not.toContain("Show setup steps");
    }
  });
});

describe("the health line (ruling 261)", () => {
  /** The tone the status dot is painted in: its one `bg-<tone>` class. */
  function dotTone(html: string) {
    return /role="status"[^>]*><span aria-hidden="true" class="[^"]*\bbg-(ok|warn|danger)\b/u.exec(
      html,
    )?.[1];
  }

  /** The health line's text, from its status dot to its end. */
  async function healthLine() {
    const html = await markup();
    const start = html.indexOf('role="status"');
    if (start < 0) return { html, line: "" };
    return { html, line: text(html.slice(start)) };
  }

  test("says how this organization's events stand, naming them rather than the worker, and when the database answered", async () => {
    const { html, line } = await healthLine();

    expect(line).toMatch(/^[\s\S]*?This organization’s events are on time/u);
    expect(line).toContain(
      "on time · none waiting; no dead letters in 24 hours; last dispatched 3 minutes ago",
    );
    expect(line).toContain("Database answered at 20:31:05 UTC");
    // The read measures this organization's events alone, so no verdict
    // speaks for the worker as a whole.
    expect(line).not.toMatch(/worker/iu);
    expect(html).toMatch(/datetime="2026-10-25T20:31:05\.000Z"/iu);
    expect(html).toContain('href="/settings/operations"');
    expect(dotTone(html)).toBe("ok");
  });

  test("counts what waits, and how long the oldest has, against the read's own clock", async () => {
    reads.health.mockResolvedValue(
      health({
        oldestUnprocessedAt: minutesBeforeCheck(14),
        unprocessedEvents: 3,
      }),
    );
    const { line } = await healthLine();

    expect(line).toContain(
      "3 not yet processed, the oldest written 14 minutes ago",
    );
  });

  test.each([
    [9, 0, "ok", "This organization’s events are on time"],
    [10, 0, "warn", "This organization’s events need attention"],
    [59, 0, "warn", "This organization’s events need attention"],
    [60, 0, "danger", "This organization’s events are an hour or more behind"],
    [0, 1, "warn", "This organization’s events need attention"],
    [61, 2, "danger", "This organization’s events are an hour or more behind"],
  ] as const)(
    "an event %i minutes old and %i dead letters read as %s",
    async (minutes, deadLetters, tone, verdict) => {
      reads.health.mockResolvedValue(
        health({
          deadLetters,
          oldestUnprocessedAt: minutes ? minutesBeforeCheck(minutes) : null,
          unprocessedEvents: minutes ? 1 : 0,
        }),
      );
      const { html, line } = await healthLine();

      expect(line).toContain(verdict);
      expect(line).not.toMatch(/worker/iu);
      expect(dotTone(html)).toBe(tone);
    },
  );

  test("names a dead letter and a worker that never dispatched", async () => {
    reads.health.mockResolvedValue(
      health({ deadLetters: 1, lastDispatchAt: null }),
    );
    const { line } = await healthLine();

    expect(line).toContain("1 dead letter in 24 hours");
    expect(line).toContain("nothing dispatched yet");
  });

  test("is not drawn for a member, even were the health read to answer", async () => {
    reads.organization = {
      id: organizationId,
      name: "CUE++",
      role: "member",
      slug: "example-org",
    };
    reads.summary.mockResolvedValue(
      summary({ failedDeliveries: null, role: "member" }),
    );
    // The repository answers null for a member (its own suite pins that);
    // here it answers, so the view's own owner-or-admin guard is what keeps
    // the line off.
    reads.health.mockResolvedValue(health());
    const html = await markup();

    expect(html).not.toContain("Database answered");
    expect(html).not.toContain("This organization’s events");
    expect(html).not.toContain('role="status"');
  });
});

describe("without an organization", () => {
  test("offers the first-organization form and reads nothing", async () => {
    reads.organization = null;
    const html = await markup();

    expect(html).toContain("Create your first organization");
    expect(reads.summary).not.toHaveBeenCalled();
  });
});
