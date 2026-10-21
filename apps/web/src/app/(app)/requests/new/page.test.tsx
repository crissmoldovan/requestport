import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const creation = vi.hoisted(() => ({
  listProjects: vi.fn(),
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

vi.mock("@requestport/db", () => ({
  createFoundationQueryRepository: () => ({
    listOrganizationProjects: creation.listProjects,
  }),
}));

// The web root, whose storage the page builds its repository over when it
// runs (Plan 13, G.3).
vi.mock("../../../../lib/server-request-port.js", () => ({
  webStorage: () => ({ db: {} }),
}));

vi.mock("next/navigation", () => ({ redirect: creation.redirect }));

vi.mock("../../../../lib/server-application-context.js", () => ({
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

vi.mock("../actions.js", () => {
  const inert = async () => ({ status: "idle" as const });
  return {
    answerQuestionAction: inert,
    askQuestionAction: inert,
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

import NewRequestPage from "./page.js";

/** A retired recipe class, assembled so the audit reads bookkeeping, not a class. */
function recipeClass(...parts: readonly string[]): string {
  return ["ui", ...parts].join("-");
}

const project = {
  canRepresent: true,
  defaultRepository: null,
  id: "00000000-0000-4000-8000-0000000000c1",
  keyPrefix: "PLT",
  name: "Platform",
  slug: "platform",
  status: "active",
};

async function newRequestMarkup() {
  const page = (await NewRequestPage()) as ReactElement;

  return renderToStaticMarkup(page);
}

beforeEach(() => {
  creation.listProjects.mockReset();
  creation.listProjects.mockResolvedValue([project]);
  creation.redirect.mockClear();
});

describe("new request page", () => {
  test("offers the cancel route as a native button-shaped link", async () => {
    const markup = await newRequestMarkup();

    expect(markup).toContain('href="/requests"');
    expect(markup).toContain("Cancel");
    expect(markup).not.toContain(recipeClass("button"));
  });

  test("renders the create form once a project can be targeted", async () => {
    const markup = await newRequestMarkup();

    expect(markup).toContain('name="idempotencyKey"');
    expect(markup).toContain('name="targetProjectId"');
    expect(markup).toContain('data-slot="field"');
    expect(markup).not.toContain("<select");
  });

  test("sends an organization with no active project to create one first", async () => {
    creation.listProjects.mockResolvedValue([
      { ...project, status: "archived" },
    ]);

    const markup = await newRequestMarkup();

    expect(markup).toContain('data-slot="empty-state"');
    expect(markup).toContain('data-slot="empty-state-action"');
    expect(markup).toContain("Register a project first");
    expect(markup).toContain('href="/settings/projects/new"');
    expect(markup).not.toContain(recipeClass("empty-state"));
  });
});
