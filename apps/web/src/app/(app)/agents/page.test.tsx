import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const agents = vi.hoisted(() => ({
  connections: vi.fn(),
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
  createAgentManagementRepository: () => ({ listAgents: agents.list }),
  createFoundationQueryRepository: () => ({
    listOrganizationLanes: agents.lanes,
  }),
  createOverviewQueryRepository: () => ({
    listAgentConnections: agents.connections,
  }),
  createProjectSettingsRepository: () => ({
    listManageableProjects: agents.projects,
  }),
}));

// The web root, whose storage the page builds its repositories over when it
// runs (Plan 13, G.3).
vi.mock("../../../lib/server-request-port.js", () => ({
  webStorage: () => ({ db: {} }),
}));

vi.mock("@requestport/config/server", () => ({
  serverEnv: { BETTER_AUTH_URL: "https://requestport.example" },
}));

vi.mock("../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization: agents.organization,
    session: { user: { id: "00000000-0000-4000-8000-0000000000aa" } },
  }),
}));

vi.mock("./actions.js", () => ({
  createAgentAction: async () => ({ message: "", status: "idle" }),
  issueAgentKeyAction: async () => ({ message: "", status: "idle" }),
}));

import { acceptanceSurface } from "../../../test/acceptance-surfaces.js";
import AgentsPage from "./page.js";

/** A retired recipe class, assembled so the audit reads bookkeeping, not a class. */
function recipeClass(...parts: readonly string[]): string {
  return ["ui", ...parts].join("-");
}

const listed = {
  activeSessionCount: 0,
  displayName: "Claude Code",
  id: "00000000-0000-4000-8000-0000000000a1",
  installationCount: 1,
  projectId: "00000000-0000-4000-8000-0000000000c1",
  projectName: "Platform",
  slug: "claude-code",
  softwareName: "Claude Code CLI",
  status: "active",
  updatedAt: new Date("2026-08-20T10:00:00.000Z"),
  version: 3,
};

const noSignIn = {
  activeGrantCount: 0,
  activeKeyCount: 0,
  agentPrincipalId: listed.id,
  lastSignedInAt: null,
  openAssignedCount: 0,
  workingSessionCount: 0,
};

async function markup() {
  return renderToStaticMarkup((await AgentsPage()) as ReactElement);
}

/** The text of the table row that names this agent. */
function rowOf(html: string, name: string) {
  const row = html
    .split("<tr")
    .find((candidate) => candidate.includes(`>${name}</a>`));
  if (!row) throw new Error(`no row for ${name}`);
  return row.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");
}

beforeEach(() => {
  agents.organization = {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  };
  for (const read of [
    agents.connections,
    agents.lanes,
    agents.list,
    agents.projects,
  ]) {
    read.mockReset();
  }
  agents.list.mockResolvedValue([listed]);
  agents.connections.mockResolvedValue([noSignIn]);
  agents.lanes.mockResolvedValue([]);
  agents.projects.mockResolvedValue([
    { id: "00000000-0000-4000-8000-0000000000c1", name: "Platform" },
  ]);
});

describe("the agents table", () => {
  test("puts the agents in a named, keyboard-reachable table region", async () => {
    const html = await markup();

    expect(html).toContain('data-slot="table-scroll-region"');
    expect(html).toContain('aria-label="Registered agents"');
    expect(html).toContain('data-slot="table"');
    expect(html).toContain('data-slot="table-caption"');
    for (const heading of [
      "Agent",
      "Status",
      "Signs in with",
      "Default project",
      "Open, assigned",
    ]) {
      expect(html).toContain(`>${heading}</th>`);
    }
  });

  test("names each agent with its software, and leads to where it is managed", async () => {
    const html = await markup();
    const row = rowOf(html, "Claude Code");

    expect(row).toContain("Claude Code CLI");
    expect(row).toContain("Platform");
    expect(html).toContain(`href="/agents/${listed.id}"`);
    expect(html).toContain('aria-label="Manage Claude Code"');
  });

  test("reads an agent's state as a labelled chip from what the data holds", async () => {
    agents.list.mockResolvedValue([
      { ...listed, displayName: "Working agent" },
      {
        ...listed,
        // The agent list counts paused, blocked and stale sessions as open;
        // none of them is work under way.
        activeSessionCount: 3,
        displayName: "Idle agent",
        id: "00000000-0000-4000-8000-0000000000a2",
      },
      {
        ...listed,
        displayName: "Paused agent",
        id: "00000000-0000-4000-8000-0000000000a3",
        status: "suspended",
      },
      {
        ...listed,
        displayName: "Gone agent",
        id: "00000000-0000-4000-8000-0000000000a4",
        status: "revoked",
      },
    ]);
    // Listed in another order than the agents, so a row that took the
    // connection at its own position would read another agent's.
    agents.connections.mockResolvedValue([
      { ...noSignIn, agentPrincipalId: "00000000-0000-4000-8000-0000000000a2" },
      { ...noSignIn, workingSessionCount: 2 },
    ]);
    const html = await markup();

    expect(rowOf(html, "Working agent")).toContain("Working · 2 sessions");
    expect(rowOf(html, "Idle agent")).toContain("Active");
    expect(rowOf(html, "Idle agent")).not.toContain("Working");
    expect(rowOf(html, "Paused agent")).toContain("Suspended");
    expect(rowOf(html, "Gone agent")).toContain("Revoked");
    expect(html).not.toContain(recipeClass("badge"));
  });

  test("says how each agent signs in, from its active keys and grants, and when it last did, OAuth included (ruling 261)", async () => {
    agents.list.mockResolvedValue([
      listed,
      {
        ...listed,
        displayName: "Delegated agent",
        id: "00000000-0000-4000-8000-0000000000a2",
        projectId: null,
        projectName: null,
      },
      {
        ...listed,
        displayName: "New agent",
        id: "00000000-0000-4000-8000-0000000000a3",
      },
      {
        ...listed,
        displayName: "Both ways agent",
        id: "00000000-0000-4000-8000-0000000000a4",
      },
      {
        ...listed,
        displayName: "Suspended agent",
        id: "00000000-0000-4000-8000-0000000000a5",
        status: "suspended",
      },
    ]);
    // In another order than the agents: each row finds its own by id.
    const hoursAgo = (hours: number) =>
      new Date(Date.now() - hours * 60 * 60 * 1000);
    agents.connections.mockResolvedValue([
      {
        ...noSignIn,
        agentPrincipalId: "00000000-0000-4000-8000-0000000000a5",
        lastSignedInAt: hoursAgo(72),
      },
      {
        ...noSignIn,
        activeGrantCount: 1,
        activeKeyCount: 1,
        agentPrincipalId: "00000000-0000-4000-8000-0000000000a4",
      },
      { ...noSignIn, agentPrincipalId: "00000000-0000-4000-8000-0000000000a3" },
      {
        ...noSignIn,
        activeGrantCount: 1,
        agentPrincipalId: "00000000-0000-4000-8000-0000000000a2",
        lastSignedInAt: new Date(Date.now() - 5 * 60 * 1000),
      },
      {
        ...noSignIn,
        activeKeyCount: 2,
        lastSignedInAt: hoursAgo(1),
        openAssignedCount: 3,
      },
    ]);
    const html = await markup();

    expect(rowOf(html, "Claude Code")).toMatch(
      /API key 2 active keys Last signed in 1 hour ago .* 3 /u,
    );
    // An OAuth agent's last sign-in, which nothing recorded before 0027.
    expect(rowOf(html, "Delegated agent")).toMatch(
      /OAuth 1 active grant Last signed in 5 minutes ago Organization-wide 0 /u,
    );
    // No stamp says only that none was recorded: an OAuth sign-in before
    // 0027 left none.
    expect(rowOf(html, "Both ways agent")).toMatch(
      /OAuth and API key 1 active grant · 1 active key No sign-in recorded /u,
    );
    expect(rowOf(html, "New agent")).toMatch(
      /No active sign-in No sign-in recorded /u,
    );
    // Nothing signs a suspended agent in now; when it last did is history.
    expect(rowOf(html, "Suspended agent")).toMatch(
      /Suspended No active sign-in Last signed in 3 days ago /u,
    );
    expect(html).not.toContain("Not signed in yet");
    expect(html).not.toContain("never used");
  });

  test("reports an organization with no agents as a native empty state", async () => {
    agents.list.mockResolvedValue([]);
    agents.connections.mockResolvedValue([]);
    const html = await markup();

    expect(html).toContain('data-slot="empty-state"');
    expect(html).toContain("No agents registered");
    expect(html).not.toContain(recipeClass("empty-state"));
    expect(html).not.toContain('data-slot="table"');
  });
});

describe("the endpoints", () => {
  test("derives all three from the deployment's base URL, each with a copy control", async () => {
    const html = await markup();

    for (const [label, url] of [
      ["MCP endpoint", "https://requestport.example/mcp"],
      ["REST base URL", "https://requestport.example/api/v1"],
      [
        "OAuth resource metadata",
        "https://requestport.example/.well-known/oauth-protected-resource/mcp",
      ],
    ]) {
      expect(html).toContain(label);
      expect(html).toContain(url);
      expect(html).toContain(`aria-label="Copy the ${label}"`);
    }
  });
});

describe("connecting an agent", () => {
  test("is offered to an owner and to a maintainer, and withheld from a member with no project", async () => {
    expect(await markup()).toContain(">Connect an agent<");

    agents.organization = {
      id: "00000000-0000-4000-8000-0000000000d1",
      name: "CUE++",
      role: "member",
      slug: "example-org",
    };
    expect(await markup()).toContain(">Connect an agent<");

    agents.projects.mockResolvedValue([]);
    expect(await markup()).not.toContain(">Connect an agent<");
  });

  test("is the control the acceptance surface opens to find the owner-only choice", async () => {
    // The organization-wide choice now sits in the sheet's create form, so
    // `member_denied` opens the sheet by this name before it reads the
    // controls (tests/fixtures/acceptance-drivers.ts).
    const surface = acceptanceSurface("route:/agents");

    expect(surface.ownerOnlyControl).toBe("Organization-wide");
    expect(surface.ownerOnlyControlOpener).toBe("Connect an agent");
    expect(await markup()).toContain(`>${surface.ownerOnlyControlOpener}<`);
  });

  test("renders nothing at all without an active organization", async () => {
    agents.organization = null;

    expect(await AgentsPage()).toBeNull();
  });
});
