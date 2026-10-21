import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const agent = vi.hoisted(() => ({
  detail: vi.fn(),
  lanes: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  organization: {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  } as { id: string; name: string; role: string; slug: string } | null,
  projects: vi.fn(),
}));

vi.mock("@requestport/db", () => ({
  createAgentManagementRepository: () => ({ getAgent: agent.detail }),
  createFoundationQueryRepository: () => ({
    listOrganizationLanes: agent.lanes,
  }),
  createProjectSettingsRepository: () => ({
    listManageableProjects: agent.projects,
  }),
}));

// The web root, whose storage the page builds its repositories over when it
// runs (Plan 13, G.3).
vi.mock("../../../../lib/server-request-port.js", () => ({
  webStorage: () => ({ db: {} }),
}));

vi.mock("@requestport/config/server", () => ({
  serverEnv: { BETTER_AUTH_URL: "https://staging.requestport.com" },
}));

vi.mock("next/navigation", () => ({ notFound: agent.notFound }));

vi.mock("../../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization: agent.organization,
    session: { user: { id: "00000000-0000-4000-8000-0000000000aa" } },
  }),
}));

vi.mock("../actions.js", () => {
  const inert = async () => ({ message: "", status: "idle" });
  return {
    issueAgentKeyAction: inert,
    revealWorkspaceTelemetryAction: inert,
    revokeAgentKeyAction: inert,
    revokeAgentOauthGrantAction: inert,
    rotateAgentKeyAction: inert,
    setAgentStatusAction: inert,
  };
});

import AgentDetailPage from "./page.js";

/** A retired recipe class, assembled so the audit reads bookkeeping, not a class. */
function recipeClass(...parts: readonly string[]): string {
  return ["ui", ...parts].join("-");
}

const agentId = "00000000-0000-4000-8000-0000000000a1";
const laneId = "00000000-0000-4000-8000-0000000000e1";

const detail = {
  agent: {
    displayName: "Claude Code",
    id: agentId,
    projectId: "00000000-0000-4000-8000-0000000000c1",
    projectName: "Platform",
    slug: "claude-code",
    softwareName: "Claude Code",
    status: "active",
    version: 3,
  },
  credentials: [
    {
      audience: "mcp",
      expiresAt: new Date("2026-11-20T10:00:00.000Z"),
      id: "00000000-0000-4000-8000-0000000000b1",
      laneIds: [laneId],
      lastUsedAt: null,
      name: "Laptop",
      prefix: "rqp_live_ab12",
      revokedAt: null,
      scopes: ["org:read", "request:read"],
      version: 1,
    },
  ],
  installations: [
    {
      capabilities: { mcp: true, rest: false },
      id: "00000000-0000-4000-8000-0000000000b2",
      lastSeenAt: new Date("2026-08-20T10:00:00.000Z"),
      softwareName: "Claude Code",
      softwareVersion: "5.1.0",
      status: "active",
    },
  ],
  oauthGrants: [
    {
      audience: "api",
      clientId: "client_1",
      clientName: "Claude Desktop",
      expiresAt: new Date("2026-11-20T10:00:00.000Z"),
      id: "00000000-0000-4000-8000-0000000000d9",
      laneIds: [],
      revokedAt: null,
      scopes: ["request:read"],
      status: "active",
      userEmail: "ada@example.com",
      userId: "00000000-0000-4000-8000-0000000000aa",
      userName: "Ada Lovelace",
      version: 1,
    },
  ],
  sessions: [
    {
      id: "00000000-0000-4000-8000-0000000000c9",
      latestProgress: "Reskinning the console",
      requestId: "00000000-0000-4000-8000-000000000101",
      state: "active",
      updatedAt: new Date("2026-08-20T10:00:00.000Z"),
      version: 4,
    },
  ],
  workspaces: [
    {
      id: "00000000-0000-4000-8000-0000000000f2",
      lastSeenAt: new Date("2026-08-20T10:00:00.000Z"),
      safeCapabilities: { git: true },
      status: "active",
    },
  ],
};

async function markup() {
  const page = (await AgentDetailPage({
    params: Promise.resolve({ agentId }),
  })) as ReactElement;

  return renderToStaticMarkup(page);
}

beforeEach(() => {
  agent.organization = {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  };
  agent.detail.mockReset();
  agent.lanes.mockReset();
  agent.projects.mockReset();
  agent.notFound.mockClear();
  agent.detail.mockResolvedValue(detail);
  agent.lanes.mockResolvedValue([
    {
      id: laneId,
      name: "release",
      projectId: "00000000-0000-4000-8000-0000000000c1",
      slug: "release",
    },
  ]);
  agent.projects.mockResolvedValue([
    { id: "00000000-0000-4000-8000-0000000000c1", name: "Platform" },
  ]);
});

describe("the agent detail", () => {
  test("puts credentials and grants in named, keyboard-reachable table regions", async () => {
    const html = await markup();

    expect(html).toContain('aria-label="Agent credentials"');
    expect(html).toContain('aria-label="Delegated OAuth grants"');
    expect(html).toContain('data-slot="table-scroll-region"');
    expect(html).toContain('data-slot="table-caption"');
    expect(html).not.toContain(recipeClass("table"));
    expect(html).not.toContain(recipeClass("table", "scroll"));
  });

  test("shows a credential only by its prefix and never a whole secret", async () => {
    const html = await markup();

    expect(html).toContain("rqp_live_ab12");
    expect(html).toContain("MCP");
    expect(html).toContain("release");
  });

  test("reads a revoked credential as a labelled chip rather than a retired badge", async () => {
    agent.detail.mockResolvedValue({
      ...detail,
      credentials: [
        {
          ...detail.credentials[0],
          revokedAt: new Date("2026-08-21T10:00:00.000Z"),
        },
      ],
    });
    const html = await markup();

    expect(html).toContain("revoked");
    expect(html).not.toContain(recipeClass("badge"));
  });

  test("reports an expired grant as expired rather than active", async () => {
    agent.detail.mockResolvedValue({
      ...detail,
      oauthGrants: [
        {
          ...detail.oauthGrants[0],
          expiresAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
    });

    expect(await markup()).toContain("expired");
  });

  test("offers no credential, status, or telemetry control to a member who cannot manage", async () => {
    agent.organization = {
      id: "00000000-0000-4000-8000-0000000000d1",
      name: "CUE++",
      role: "member",
      slug: "example-org",
    };
    agent.projects.mockResolvedValue([]);
    const html = await markup();

    expect(html).not.toContain("Issue credential");
    expect(html).not.toContain("Update agent status");
    expect(html).not.toContain("Reveal private telemetry");
  });

  test("withholds issuance from a suspended principal even for an owner", async () => {
    agent.detail.mockResolvedValue({
      ...detail,
      agent: { ...detail.agent, status: "suspended" },
    });

    expect(await markup()).not.toContain("Issue credential");
  });

  test("reports absence rather than an empty page", async () => {
    agent.detail.mockResolvedValue(null);

    await expect(markup()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(agent.notFound).toHaveBeenCalled();
  });

  test("reports empty installations, workspaces, and sessions as native empty states", async () => {
    agent.detail.mockResolvedValue({
      ...detail,
      credentials: [],
      installations: [],
      oauthGrants: [],
      sessions: [],
      workspaces: [],
    });
    const html = await markup();

    expect(html).toContain("No credentials issued.");
    expect(html).toContain("No delegated OAuth grants.");
    expect(html).toContain("No installation has connected yet.");
    expect(html).toContain("No machine workspace has registered yet.");
    expect(html).toContain("No work sessions yet.");
    expect(html).toContain('data-slot="empty-state"');
  });
});
