import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const webhooks = vi.hoisted(() => ({
  lanes: vi.fn(),
  list: vi.fn(),
  organization: {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  } as { id: string; name: string; role: string; slug: string } | null,
  projects: vi.fn(),
}));

vi.mock("@requestport/db", () => ({
  createFoundationQueryRepository: () => ({
    listOrganizationLanes: webhooks.lanes,
    listOrganizationProjects: webhooks.projects,
  }),
  createWebhookRepository: () => ({ list: webhooks.list }),
}));

// The web root, whose storage the page builds its repositories over when it
// runs (Plan 13, G.3).
vi.mock("../../../lib/server-request-port.js", () => ({
  webStorage: () => ({ db: {} }),
}));

vi.mock("../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization: webhooks.organization,
    session: { user: { id: "00000000-0000-4000-8000-0000000000aa" } },
  }),
}));

vi.mock("./actions.js", () => {
  const inert = async () => ({ message: "", status: "idle" });
  return {
    createWebhookAction: inert,
    rotateWebhookSecretAction: inert,
    setWebhookStatusAction: inert,
    verifyWebhookAction: inert,
  };
});

import WebhooksPage from "./page.js";

/** A retired recipe class, assembled so the audit reads bookkeeping, not a class. */
function recipeClass(...parts: readonly string[]): string {
  return ["ui", ...parts].join("-");
}

const subscription = {
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  currentSecretKeyId: "key_1",
  endpointUrl:
    "https://hooks.example.invalid/requestport/a-very-long-endpoint-path-that-never-wraps",
  eventTypes: ["request.created.v1"],
  id: "00000000-0000-4000-8000-000000000101",
  laneIds: [],
  name: "Release feed",
  nextSecretKeyId: null,
  overlapEndsAt: null,
  projectIds: [],
  requestTypes: [],
  status: "active",
  verifiedAt: new Date("2026-08-02T00:00:00.000Z"),
  version: 3,
};

async function markup() {
  return renderToStaticMarkup((await WebhooksPage()) as ReactElement);
}

beforeEach(() => {
  webhooks.organization = {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  };
  webhooks.lanes.mockReset();
  webhooks.list.mockReset();
  webhooks.projects.mockReset();
  webhooks.lanes.mockResolvedValue([]);
  webhooks.list.mockResolvedValue([subscription]);
  webhooks.projects.mockResolvedValue([]);
});

describe("the webhooks page", () => {
  test("puts the subscription table in a named, keyboard-reachable region", async () => {
    const html = await markup();

    expect(html).toContain('data-slot="table-scroll-region"');
    expect(html).toContain('aria-label="Webhook subscriptions"');
    expect(html).not.toContain(recipeClass("table"));
    expect(html).not.toContain(recipeClass("table", "scroll"));
  });

  test("labels a subscription's lifecycle in words rather than by colour", async () => {
    const html = await markup();

    // `Chip` carries no data-slot of its own, so its chassis class is what says
    // a chip is what drew the label.
    expect(html).toContain("h-chip");
    expect(html).toContain("active");
    expect(html).not.toContain(recipeClass("badge"));
  });

  /**
   * It used to assert `break-all`, which was the old answer to this question
   * and the wrong one: inside a scrolling table, breaking a word mid-character
   * shattered a value beside visible free space while the region was already
   * scrolling. The region is what keeps a long endpoint in its column, so that
   * is what this asserts — and the endpoint itself stays whole.
   */
  test("keeps a long endpoint inside its own column", async () => {
    const html = await markup();

    expect(html).toContain('data-slot="table-scroll-region"');
    expect(html).not.toContain("break-all");
  });

  test("reports an organization with no subscriptions as a native empty state", async () => {
    webhooks.list.mockResolvedValue([]);
    const html = await markup();

    expect(html).toContain('data-slot="empty-state"');
    expect(html).toContain("No webhooks");
    expect(html).not.toContain(recipeClass("empty", "state"));
  });

  test("offers the create form only to an owner or admin", async () => {
    expect(await markup()).toContain("Create webhook");

    webhooks.organization = {
      id: "00000000-0000-4000-8000-0000000000d1",
      name: "CUE++",
      role: "member",
      slug: "example-org",
    };
    const denied = await markup();

    expect(denied).not.toContain("Create webhook");
    expect(denied).toContain("Webhook delivery is owner and admin only");
  });

  test("renders nothing at all without a current organization", async () => {
    webhooks.organization = null;

    expect(await markup()).toBe("");
  });
});
