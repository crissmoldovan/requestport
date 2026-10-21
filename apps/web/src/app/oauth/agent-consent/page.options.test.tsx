/**
 * What the server hands the form, rather than what the form draws.
 *
 * The options a closed `Select` holds never reach static markup, so a test
 * that greps rendered HTML for an excluded principal passes whether or not
 * the exclusion happens. These read the props instead, where the choice is.
 */
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const consent = vi.hoisted(() => ({ getConsentOptions: vi.fn() }));
type HandedOptions = {
  laneOptions: readonly { projectId: string; value: string }[];
  principalOptions: readonly { projectId: string | null; value: string }[];
};

const handed = vi.hoisted(() => ({ props: null as HandedOptions | null }));

vi.mock("@requestport/db", () => ({
  createAgentManagementRepository: () => ({
    getConsentOptions: consent.getConsentOptions,
  }),
}));

// The web root, whose storage the page builds its repository over when it
// runs (Plan 13, G.3).
vi.mock("../../../lib/server-request-port.js", () => ({
  webStorage: () => ({ db: {} }),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

vi.mock("../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    session: { user: { id: "00000000-0000-4000-8000-0000000000aa" } },
  }),
}));

vi.mock("./actions.js", () => ({
  approveAgentConsentAction: async () => {},
  denyAgentConsentAction: async () => {},
}));

vi.mock("../../../components/agent-consent-form.js", () => ({
  AgentConsentDecision: (props: HandedOptions) => {
    handed.props = props;
    return null;
  },
}));

import AgentConsentPage from "./page.js";

const laneId = "00000000-0000-4000-8000-0000000000b1";
const projectId = "00000000-0000-4000-8000-0000000000c1";
const unmanagedProjectId = "00000000-0000-4000-8000-0000000000c9";
const ownPrincipalId = "00000000-0000-4000-8000-0000000000a1";
const foreignPrincipalId = "00000000-0000-4000-8000-0000000000a2";

const options = {
  agents: [
    {
      displayName: "Release bot",
      id: ownPrincipalId,
      organizationName: "CUE++",
      projectId,
    },
    {
      displayName: "Someone else's bot",
      id: foreignPrincipalId,
      organizationName: "CUE++",
      projectId: unmanagedProjectId,
    },
  ],
  client: {
    clientId: "client-abcdef",
    name: "Fixture agent",
    uri: "https://agent.example",
  },
  lanes: [{ id: laneId, name: "release", projectId }],
  organizations: [
    { id: "00000000-0000-4000-8000-0000000000d1", name: "CUE++" },
  ],
  projects: [
    {
      id: projectId,
      name: "Platform",
      organizationId: "00000000-0000-4000-8000-0000000000d1",
      organizationName: "CUE++",
    },
  ],
};

async function handedToTheForm(scope: string) {
  const page = (await AgentConsentPage({
    searchParams: Promise.resolve({
      client_id: "client-abcdef",
      resource: "https://requestport.test/mcp",
      scope,
    }),
  })) as ReactElement;
  renderToStaticMarkup(page);
  if (!handed.props) throw new Error("the consent form was never rendered");
  return handed.props;
}

beforeEach(() => {
  handed.props = null;
  consent.getConsentOptions.mockReset();
  consent.getConsentOptions.mockResolvedValue(options);
});

describe("what the consent screen offers", () => {
  test("withholds a principal from a project this person does not manage", async () => {
    const { principalOptions } = await handedToTheForm("request:read");

    // Not merely unselectable — never sent. The browser is given no name it
    // has no business holding.
    expect(principalOptions.map((option) => option.value)).toContain(
      ownPrincipalId,
    );
    expect(principalOptions.map((option) => option.value)).not.toContain(
      foreignPrincipalId,
    );
  });

  test("sends each principal's project, so the form can narrow to one", async () => {
    const { principalOptions } = await handedToTheForm("request:read");

    expect(
      principalOptions.find((option) => option.value === ownPrincipalId)
        ?.projectId,
    ).toBe(projectId);
  });

  test("offers no lane at all for a provisioning grant", async () => {
    // A provisioning grant names no project, so every lane belongs to another
    // one and the binder refuses each. An empty list is the honest offer.
    const { laneOptions } = await handedToTheForm("project:provision");

    expect(laneOptions).toEqual([]);
  });

  test("sends each lane's project, so the form can narrow to one", async () => {
    const { laneOptions } = await handedToTheForm("request:read");

    expect(laneOptions).toEqual([
      expect.objectContaining({ projectId, value: laneId }),
    ]);
  });
});
