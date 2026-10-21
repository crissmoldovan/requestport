import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The Slack integration page, rendered server-side in each of its states.
 *
 * `serverEnv` is replaced rather than read so the provider-unavailable state is
 * reachable without a real credential anywhere near this suite: the page only
 * ever asks whether the five settings are present, so a fixture that says
 * "configured" is the whole of what it needs.
 */

const slack = vi.hoisted(() => ({
  configured: true,
  list: vi.fn(),
  members: vi.fn(),
  organization: {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  } as { id: string; name: string; role: string; slug: string } | null,
  projects: vi.fn(),
}));

vi.mock("@requestport/config/server", () => ({
  get serverEnv() {
    const present = slack.configured ? "configured" : "";
    return {
      REQUESTPORT_SLACK_CLIENT_ID: present,
      REQUESTPORT_SLACK_CLIENT_SECRET: present,
      REQUESTPORT_SLACK_SIGNING_SECRET: present,
      REQUESTPORT_SLACK_STATE_SECRET: present,
      REQUESTPORT_WORKSPACE_KEK: present,
    };
  },
}));

vi.mock("@requestport/db", () => ({
  createFoundationQueryRepository: () => ({
    listOrganizationMembers: slack.members,
    listOrganizationProjects: slack.projects,
  }),
  createSlackRepository: () => ({ list: slack.list }),
}));

// The web root, whose storage the page builds its repositories over when it
// runs (Plan 13, G.3).
vi.mock("../../../lib/server-request-port.js", () => ({
  webStorage: () => ({ db: {} }),
}));

vi.mock("../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization: slack.organization,
    session: { user: { id: "00000000-0000-4000-8000-0000000000aa" } },
  }),
}));

vi.mock("./actions.js", () => {
  const inert = async () => ({ message: "", status: "idle" });
  return {
    mapSlackUserAction: inert,
    sendSlackConnectionTestAction: inert,
    setSlackInstallationStatusAction: inert,
    setSlackRouteAction: inert,
  };
});

import SlackPage from "./page.js";

/** A retired recipe class, assembled so the audit reads bookkeeping, not a class. */
function recipeClass(...parts: readonly string[]): string {
  return ["ui", ...parts].join("-");
}

const installation = {
  botUserId: "B012ABCDEF",
  id: "00000000-0000-4000-8000-000000000201",
  scopes: ["chat:write", "im:write"],
  status: "active",
  version: 2,
  workspaceId: "T012ABCDEF",
  workspaceName: "CUE++ HQ",
};

const configuration = {
  installations: [installation],
  mappings: [
    {
      id: "00000000-0000-4000-8000-000000000301",
      installationId: installation.id,
      slackUserId: "U012ABCDEF",
      status: "active",
      userId: "00000000-0000-4000-8000-0000000000a1",
      userName: "Ada",
      version: 1,
    },
  ],
  operations: [
    {
      id: "00000000-0000-4000-8000-000000000401",
      installationId: installation.id,
      operationType: "connection_test",
      status: "succeeded",
      updatedAt: new Date("2026-08-20T10:00:00.000Z"),
    },
  ],
  routes: [
    {
      channelId: "C012ABCDEF",
      id: "00000000-0000-4000-8000-000000000501",
      mode: "channel",
      projectId: null,
      projectName: null,
      status: "active",
      version: 4,
    },
  ],
};

async function markup() {
  return renderToStaticMarkup((await SlackPage()) as ReactElement);
}

beforeEach(() => {
  slack.configured = true;
  slack.organization = {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  };
  slack.list.mockReset();
  slack.members.mockReset();
  slack.projects.mockReset();
  slack.list.mockResolvedValue(configuration);
  slack.members.mockResolvedValue([]);
  slack.projects.mockResolvedValue([]);
});

describe("the Slack page", () => {
  test("puts every record table in a named, keyboard-reachable region", async () => {
    const html = await markup();

    expect(html).toContain('data-slot="table-scroll-region"');
    expect(html).toContain('aria-label="Slack workspaces"');
    expect(html).toContain('aria-label="Slack member mappings"');
    expect(html).toContain('aria-label="Slack delivery routes"');
    expect(html).toContain('aria-label="Recent Slack operations"');
    expect(html).not.toContain(recipeClass("table"));
  });

  test("labels an installation's lifecycle in words rather than by colour", async () => {
    const html = await markup();

    // `Chip` carries no data-slot of its own, so its chassis class is what says
    // a chip is what drew the label.
    expect(html).toContain("h-chip");
    expect(html).toContain("CUE++ HQ");
    expect(html).not.toContain(recipeClass("badge"));
  });

  test("names the organization fallback route rather than leaving it blank", async () => {
    expect(await markup()).toContain("Organization fallback");
  });

  test("offers the install link as a native control", async () => {
    const html = await markup();

    expect(html).toContain('href="/api/slack/install"');
    expect(html).toContain("Connect workspace");
    expect(html).not.toContain(recipeClass("button"));
  });

  test("reports an unconfigured provider instead of offering the install link", async () => {
    slack.configured = false;
    const html = await markup();

    expect(html).toContain("Slack configuration required");
    expect(html).not.toContain('href="/api/slack/install"');
    expect(html).not.toContain(recipeClass("callout"));
  });

  test("reports an organization with no workspace as a native empty state", async () => {
    slack.list.mockResolvedValue({
      installations: [],
      mappings: [],
      operations: [],
      routes: [],
    });
    const html = await markup();

    expect(html).toContain('data-slot="empty-state"');
    expect(html).toContain("No Slack workspace");
    expect(html).not.toContain(recipeClass("empty", "state"));
  });

  test("tells an ordinary member the surface is not theirs to manage", async () => {
    slack.organization = {
      id: "00000000-0000-4000-8000-0000000000d1",
      name: "CUE++",
      role: "member",
      slug: "example-org",
    };
    const html = await markup();

    expect(html).toContain("Slack delivery is owner and admin only");
    expect(html).not.toContain("Connect workspace");
  });

  test("renders nothing at all without a current organization", async () => {
    slack.organization = null;

    expect(await markup()).toBe("");
  });
});
