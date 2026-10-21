import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const routing = vi.hoisted(() => ({
  agents: vi.fn(),
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
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
  rules: vi.fn(),
}));

vi.mock("@requestport/db", () => ({
  createAgentManagementRepository: () => ({ listAgents: routing.agents }),
  createFoundationQueryRepository: () => ({
    listOrganizationLanes: routing.lanes,
    listOrganizationProjects: routing.projects,
  }),
  createRoutingRepository: () => ({ listRulesForManager: routing.rules }),
}));

// The web root, whose storage the page builds its repositories over when it
// runs (Plan 13, G.3).
vi.mock("../../../../lib/server-request-port.js", () => ({
  webStorage: () => ({ db: {} }),
}));

vi.mock("next/navigation", () => ({
  notFound: routing.notFound,
  redirect: routing.redirect,
}));

vi.mock("../../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization: routing.organization,
    session: { user: { id: "00000000-0000-4000-8000-0000000000aa" } },
  }),
}));

vi.mock("./actions.js", () => {
  const inert = async () => ({ status: "idle" });
  return {
    createRoutingRuleAction: inert,
    disableRoutingRuleAction: inert,
    testRoutingRuleAction: inert,
    updateRoutingRuleAction: inert,
  };
});

import RoutingSettingsPage from "./page.js";

/** A retired recipe class, assembled so the audit reads bookkeeping, not a class. */
function recipeClass(...parts: readonly string[]): string {
  return ["ui", ...parts].join("-");
}

const source = "00000000-0000-4000-8000-0000000000c1";
const target = "00000000-0000-4000-8000-0000000000c2";

const rule = {
  agentPrincipalIds: [],
  decision: "deny" as const,
  enabled: true,
  humanRoles: [],
  id: "00000000-0000-4000-8000-000000000301",
  laneIds: [],
  organizationId: "00000000-0000-4000-8000-0000000000d1",
  priorities: [],
  requestTypes: ["bug" as const],
  sourceKind: "project" as const,
  sourceProjectId: source,
  specificity: 2,
  targetProjectId: target,
  version: 3,
};

async function markup() {
  return renderToStaticMarkup((await RoutingSettingsPage()) as ReactElement);
}

beforeEach(() => {
  routing.organization = {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  };
  for (const query of [
    routing.agents,
    routing.lanes,
    routing.projects,
    routing.rules,
  ]) {
    query.mockReset();
  }
  routing.notFound.mockClear();
  routing.redirect.mockClear();
  routing.agents.mockResolvedValue([
    { displayName: "Claude Code", id: "00000000-0000-4000-8000-0000000000a1" },
  ]);
  routing.lanes.mockResolvedValue([
    {
      id: "00000000-0000-4000-8000-0000000000e1",
      name: "release",
      projectId: source,
      slug: "release",
    },
  ]);
  routing.projects.mockResolvedValue([
    {
      canRepresent: true,
      defaultRepository: null,
      id: source,
      keyPrefix: "PLT",
      name: "Platform",
      slug: "platform",
      status: "active",
    },
    {
      canRepresent: true,
      defaultRepository: null,
      id: target,
      keyPrefix: "DOC",
      name: "Docs",
      slug: "docs",
      status: "active",
    },
  ]);
  routing.rules.mockResolvedValue([rule]);
});

describe("the routing policy page", () => {
  test("puts the rules in a named, keyboard-reachable table region", async () => {
    const html = await markup();

    expect(html).toContain('aria-label="Routing rules"');
    expect(html).toContain('data-slot="table-scroll-region"');
    expect(html).toContain('data-slot="table-caption"');
    expect(html).not.toContain(recipeClass("table"));
  });

  test("names both ends of a rule rather than printing raw identifiers", async () => {
    const html = await markup();

    expect(html).toContain("Platform");
    expect(html).toContain("Docs");
    expect(html).toContain("deny");
    expect(html).not.toContain(recipeClass("badge"));
  });

  test("says human direct where a rule has no source project", async () => {
    routing.rules.mockResolvedValue([
      {
        ...rule,
        sourceKind: "human_direct" as const,
        sourceProjectId: undefined,
      },
    ]);

    expect(await markup()).toContain("Human direct");
  });

  test("reports an organization with no explicit rules as a native empty state", async () => {
    routing.rules.mockResolvedValue([]);
    const html = await markup();

    expect(html).toContain('data-slot="empty-state"');
    expect(html).toContain("No explicit rules");
    expect(html).not.toContain(recipeClass("empty-state"));
  });

  test("reports a caller who may not manage routing as absent", async () => {
    routing.rules.mockResolvedValue(null);

    await expect(markup()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(routing.notFound).toHaveBeenCalled();
  });

  test("sends a caller with no active organization back to the console root", async () => {
    routing.organization = null;

    await expect(markup()).rejects.toThrow("NEXT_REDIRECT");
    expect(routing.redirect).toHaveBeenCalledWith("/");
  });
});
