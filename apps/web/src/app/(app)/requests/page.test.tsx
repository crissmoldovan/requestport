import type { ReactElement } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { RequestListView } from "../../../components/request-workflow.js";

const queries = vi.hoisted(() => ({
  countRequests: vi.fn(),
  getRequest: vi.fn(),
  listRequests: vi.fn(),
  listTimeline: vi.fn(),
  markRequestRead: vi.fn(),
}));

const foundation = vi.hoisted(() => ({
  listOrganizationMembers: vi.fn(),
}));

vi.mock("@requestport/db", () => ({
  createFoundationQueryRepository: () => ({
    listOrganizationLanes: async () => [],
    listOrganizationMembers: foundation.listOrganizationMembers,
    listOrganizationProjects: async () => [],
  }),
  createRequestQueryRepository: () => queries,
}));

vi.mock("../../../lib/server-request-port.js", () => ({
  webStorage: () => ({ db: {} }),
}));

vi.mock("../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization: {
      id: "00000000-0000-4000-8000-0000000000d1",
      name: "CUE++",
      role: "owner",
      slug: "example-org",
    },
    session: { user: { id: "00000000-0000-4000-8000-0000000000aa" } },
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
}));

// The page is read for what it hands the view, not for the view's markup,
// which `request-workflow.test.tsx` renders.
vi.mock("../../../components/request-workflow.js", () => ({
  RequestListView: () => null,
}));

import RequestsPage from "./page.js";

type ViewProps = Parameters<typeof RequestListView>[0];

async function readList(query: Record<string, string>) {
  const element = (await RequestsPage({
    searchParams: Promise.resolve(query),
  })) as ReactElement<ViewProps>;
  return {
    filters: queries.listRequests.mock.calls[0]?.[0]?.filters,
    listCursor: queries.listRequests.mock.calls[0]?.[0]?.cursor,
    props: element.props,
  };
}

beforeEach(() => {
  queries.listRequests.mockReset();
  queries.listRequests.mockResolvedValue({ items: [], nextCursor: null });
  queries.countRequests.mockReset();
  queries.countRequests.mockResolvedValue({
    all: 9,
    inbox: 2,
    my_work: 4,
    waiting: 1,
  });
  foundation.listOrganizationMembers.mockReset();
  foundation.listOrganizationMembers.mockResolvedValue([]);
});

describe("the requests page's address", () => {
  test("treats an updated-after date it cannot read as no filter at all", async () => {
    const { filters, props } = await readList({
      state: "triage",
      updatedAfter: "not-a-date",
    });

    expect(filters).toEqual({ mode: "all", state: ["triage"] });
    // Not applied, so not drawn as a chip, counted, or carried into links.
    expect(props.query.updatedAfter).toBeUndefined();
    expect(props.queryString).toBe("state=triage");
  });

  test("applies an updated-after date it can read, and keeps it as written", async () => {
    const { filters, props } = await readList({ updatedAfter: "2026-08-19" });

    expect(filters).toEqual({
      mode: "all",
      updatedAfter: new Date("2026-08-19"),
    });
    expect(props.query.updatedAfter).toBe("2026-08-19");
    expect(props.queryString).toBe("updatedAfter=2026-08-19");
  });

  test("hands the view the page it read, outside the query its views and filters keep", async () => {
    const { listCursor, props } = await readList({
      cursor: "c1",
      view: "inbox",
    });

    expect(listCursor).toBe("c1");
    expect(props.cursor).toBe("c1");
    expect(props.queryString).toBe("view=inbox");
  });
});

/*
  Ruling 262: each view tab's count is read under the filters the tab's own
  address keeps, and the members whom a selected request can be assigned to
  are read only when one is selected.
*/
describe("the view counts and the assignable members", () => {
  test("counts each view with the filters in force, every view dropping unanswered but Waiting on an answer", async () => {
    const { props } = await readList({
      view: "inbox",
      state: "triage",
      unanswered: "true",
      cursor: "c1",
    });

    expect(queries.countRequests).toHaveBeenCalledOnce();
    expect(queries.countRequests.mock.calls[0]?.[0]).toEqual({
      userId: "00000000-0000-4000-8000-0000000000aa",
      organizationId: "00000000-0000-4000-8000-0000000000d1",
      views: {
        all: { mode: "all", state: ["triage"] },
        inbox: { mode: "inbox", state: ["triage"] },
        my_work: { mode: "my_work", state: ["triage"] },
        waiting: { mode: "all", state: ["triage"], unanswered: true },
      },
    });
    expect(props.counts).toEqual({ all: 9, inbox: 2, my_work: 4, waiting: 1 });
    // The list itself still reads the view and the filter it was given.
    expect(queries.listRequests.mock.calls[0]?.[0]?.filters).toEqual({
      mode: "inbox",
      state: ["triage"],
      unanswered: true,
    });
  });

  // Ruling 264: the filter sheet offers the members as reporter and
  // assignee, so the list reads them whether or not a request is selected.
  test("reads the members on every load, for the filter sheet and the selected request", async () => {
    foundation.listOrganizationMembers.mockResolvedValue([
      { userId: "u1", name: "Ada", email: "ada@example.com" },
    ]);
    const { props: unselected } = await readList({});
    expect(foundation.listOrganizationMembers).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-0000000000aa",
      "00000000-0000-4000-8000-0000000000d1",
    );
    expect(unselected.members).toEqual([
      { userId: "u1", name: "Ada", email: "ada@example.com" },
    ]);

    queries.getRequest.mockResolvedValue(null);
    queries.listTimeline.mockResolvedValue({ items: [], nextCursor: null });
    const { props } = await readList({
      requestId: "00000000-0000-4000-8000-000000000101",
    });
    expect(foundation.listOrganizationMembers).toHaveBeenCalledTimes(2);
    expect(props.members).toEqual([
      { userId: "u1", name: "Ada", email: "ada@example.com" },
    ]);
  });
});
