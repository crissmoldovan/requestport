import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const project = vi.hoisted(() => ({
  detail: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  organization: {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  } as { id: string; name: string; role: string; slug: string } | null,
}));

vi.mock("@requestport/db", () => ({
  createProjectSettingsRepository: () => ({ getProject: project.detail }),
}));

// The web root, whose storage the page builds its repository over when it
// runs (Plan 13, G.3).
vi.mock("../../../../../lib/server-request-port.js", () => ({
  webStorage: () => ({ db: {} }),
}));

vi.mock("next/navigation", () => ({ notFound: project.notFound }));

vi.mock("../../../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization: project.organization,
    session: { user: { id: "00000000-0000-4000-8000-0000000000aa" } },
  }),
}));

vi.mock("./actions.js", () => {
  const inert = async () => ({ status: "idle" });
  return {
    addAliasAction: inert,
    addLaneAction: inert,
    addRepositoryAction: inert,
    setDefaultLaneAction: inert,
    setDefaultRepositoryAction: inert,
    setLaneStatusAction: inert,
    setProjectMemberAction: inert,
    setProjectStatusAction: inert,
    setProjectWorkPolicyAction: inert,
    setRepositoryStatusAction: inert,
    updateProjectMetadataAction: inert,
  };
});

import { ConsoleToasts } from "../../../../../components/console-toasts.js";
import ProjectSettingsDetailPage from "./page.js";

/** A retired recipe class, assembled so the audit reads bookkeeping, not a class. */
function recipeClass(...parts: readonly string[]): string {
  return ["ui", ...parts].join("-");
}

const projectId = "00000000-0000-4000-8000-0000000000c1";

const detail = {
  aliases: [
    {
      alias: "legacy-platform",
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
      id: "00000000-0000-4000-8000-000000000501",
      source: "import",
    },
  ],
  availableMembers: [
    { email: "ada@example.com", name: "Ada Lovelace", userId: "user_2" },
  ],
  canManage: true,
  lanes: [
    {
      id: "00000000-0000-4000-8000-0000000000e1",
      name: "release",
      slug: "release",
      status: "active",
    },
  ],
  members: [
    {
      email: "ada@example.com",
      id: "00000000-0000-4000-8000-000000000502",
      name: "Ada Lovelace",
      role: "maintainer",
      status: "active",
      userId: "user_2",
    },
  ],
  project: {
    defaultLaneId: "00000000-0000-4000-8000-0000000000e1",
    description: "The console",
    graceSeconds: 900,
    heartbeatIntervalSeconds: 30,
    id: projectId,
    keyPrefix: "PLT",
    leaseMultiplier: 3,
    name: "Platform",
    requiredWorkspaceFields: ["hostname"],
    slug: "platform",
    status: "active",
    version: 7,
  },
  repositories: [
    {
      browseUrl: "https://github.com/example-org/requestport",
      cloneUrl: "https://github.com/example-org/requestport.git",
      id: "00000000-0000-4000-8000-000000000503",
      isDefault: true,
      repositorySlug: "example-org/requestport",
      status: "active",
    },
  ],
};

async function markup() {
  const page = (await ProjectSettingsDetailPage({
    params: Promise.resolve({ projectId }),
  })) as ReactElement;

  // Inside the console's toast provider, which the shell mounts around every
  // page (ruling 260): the page's dialogs raise their confirmations there.
  return renderToStaticMarkup(<ConsoleToasts>{page}</ConsoleToasts>);
}

beforeEach(() => {
  project.organization = {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  };
  project.detail.mockReset();
  project.notFound.mockClear();
  project.detail.mockResolvedValue(detail);
});

describe("the project settings detail", () => {
  test("puts repositories, lanes, and access in named table regions", async () => {
    const html = await markup();

    expect(html).toContain('aria-label="Project repositories"');
    expect(html).toContain('aria-label="Project lanes"');
    expect(html).toContain('aria-label="Project members"');
    expect(html).toContain('data-slot="table-scroll-region"');
    expect(html).toContain('data-slot="table-caption"');
    expect(html).not.toContain(recipeClass("table"));
  });

  test("reads status and default marks as labelled chips, not retired badges", async () => {
    const html = await markup();

    expect(html).toContain("Default");
    expect(html).toContain("example-org/requestport");
    expect(html).not.toContain(recipeClass("badge"));
  });

  test("reports an empty repository, alias, and lane set as native empty states", async () => {
    project.detail.mockResolvedValue({
      ...detail,
      aliases: [],
      lanes: [],
      members: [],
      repositories: [],
    });
    const html = await markup();

    expect(html).toContain('data-slot="empty-state"');
    expect(html).toContain("No repositories");
    expect(html).toContain("No aliases registered");
    expect(html).toContain("No lanes registered");
  });

  test("withholds every editing control from someone who cannot maintain the project", async () => {
    project.detail.mockResolvedValue({ ...detail, canManage: false });
    const html = await markup();

    expect(html).toContain(
      "Only a project maintainer can change project details.",
    );
    expect(html).toContain("Only a project maintainer can change work policy.");
    // The four panel actions, by the labels their triggers print. Their
    // dialogs' submits never reach this markup (a dialog's content renders
    // only once it is open), so the trigger is what a non-maintainer must
    // not be handed.
    expect(html).not.toContain("Add repository");
    expect(html).not.toContain("Add alias");
    expect(html).not.toContain("Add lane");
    expect(html).not.toContain("Set project role");
    expect(html).not.toContain('data-slot="dialog-trigger"');
  });

  test("opens each list's add form in a dialog from its panel, and keeps the edit forms on the page (ruling 259)", async () => {
    const html = await markup();

    for (const trigger of [
      "Add repository",
      "Add alias",
      "Add lane",
      "Set project role",
    ]) {
      expect({ present: html.includes(`>${trigger}<`), trigger }).toEqual({
        present: true,
        trigger,
      });
    }
    expect(html.match(/data-slot="dialog-trigger"/gu)).toHaveLength(4);
    // Their fields are in the dialogs, not under the lists.
    expect(html).not.toContain('name="repositoryUrl"');
    expect(html).not.toContain('name="alias"');
    expect(html).not.toContain("Save project role");
    // The details form edits what is there, so it stays inline.
    expect(html).toContain('name="description"');
  });

  test("reports absence rather than an empty page", async () => {
    project.detail.mockResolvedValue(null);

    await expect(markup()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(project.notFound).toHaveBeenCalled();
  });

  test("reports a caller with no active organization as absent", async () => {
    project.organization = null;

    await expect(markup()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(project.notFound).toHaveBeenCalled();
  });
});
