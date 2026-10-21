import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const agents = vi.hoisted(() => ({
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
  serverEnv: { BETTER_AUTH_URL: "https://staging.requestport.com" },
}));

vi.mock("../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization: agents.organization,
    session: { user: { id: "00000000-0000-4000-8000-0000000000aa" } },
  }),
}));

vi.mock("./actions.js", () => ({
  createAgentAction: async () => ({ message: "", status: "idle" }),
}));

import AgentsPage from "./page.js";

/** A retired recipe class, assembled so the audit reads bookkeeping, not a class. */
function recipeClass(...parts: readonly string[]): string {
  return ["ui", ...parts].join("-");
}

const listed = {
  activeSessionCount: 2,
  displayName: "Claude Code",
  id: "00000000-0000-4000-8000-0000000000a1",
  installationCount: 1,
  projectId: "00000000-0000-4000-8000-0000000000c1",
  projectName: "Platform",
  slug: "claude-code",
  softwareName: "Claude Code",
  status: "active",
  updatedAt: new Date("2026-08-20T10:00:00.000Z"),
  version: 3,
};

async function markup() {
  return renderToStaticMarkup((await AgentsPage()) as ReactElement);
}

beforeEach(() => {
  agents.organization = {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  };
  agents.list.mockReset();
  agents.projects.mockReset();
  agents.list.mockResolvedValue([listed]);
  agents.projects.mockResolvedValue([
    { id: "00000000-0000-4000-8000-0000000000c1", name: "Platform" },
  ]);
});

describe("the agents list", () => {
  test("puts the principals in a named, keyboard-reachable table region", async () => {
    const html = await markup();

    expect(html).toContain('data-slot="table-scroll-region"');
    expect(html).toContain('aria-label="Registered agents"');
    expect(html).toContain('data-slot="table"');
    expect(html).toContain('data-slot="table-caption"');
    expect(html).toContain("Claude Code");
    expect(html).toContain("claude-code");
  });

  test("reads a principal's lifecycle as a labelled chip, never colour alone", async () => {
    agents.list.mockResolvedValue([{ ...listed, status: "revoked" }]);
    const html = await markup();

    expect(html).toContain("revoked");
    expect(html).not.toContain(recipeClass("badge"));
  });

  test("reports an organization with no agents as a native empty state", async () => {
    agents.list.mockResolvedValue([]);
    const html = await markup();

    expect(html).toContain('data-slot="empty-state"');
    expect(html).toContain("No agents registered");
    expect(html).not.toContain(recipeClass("empty-state"));
    expect(html).not.toContain('data-slot="table"');
  });

  test("offers registration to an owner and withholds it from a member with no project", async () => {
    expect(await markup()).toContain("Create agent principal");

    agents.organization = {
      id: "00000000-0000-4000-8000-0000000000d1",
      name: "CUE++",
      role: "member",
      slug: "example-org",
    };
    agents.projects.mockResolvedValue([]);
    expect(await markup()).not.toContain("Create agent principal");
  });

  test("renders nothing at all without an active organization", async () => {
    agents.organization = null;

    expect(await AgentsPage()).toBeNull();
  });
});
