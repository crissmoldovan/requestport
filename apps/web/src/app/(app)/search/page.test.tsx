import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const search = vi.hoisted(() => ({
  organization: {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner" as const,
    slug: "example-org",
  } as { id: string; name: string; role: string; slug: string } | null,
  run: vi.fn(),
}));

vi.mock("@requestport/db", () => ({
  createSearchRepository: () => ({ search: search.run }),
}));

// The web root, whose storage the page builds its repository over when it
// runs (Plan 13, G.3).
vi.mock("../../../lib/server-request-port.js", () => ({
  webStorage: () => ({ db: {} }),
}));

vi.mock("../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization: search.organization,
    session: { user: { id: "00000000-0000-4000-8000-0000000000aa" } },
  }),
}));

import SearchPage from "./page.js";

/** A retired recipe class, assembled so the audit reads bookkeeping, not a class. */
function recipeClass(...parts: readonly string[]): string {
  return ["ui", ...parts].join("-");
}

const results = {
  projects: [
    {
      id: "00000000-0000-4000-8000-0000000000c1",
      keyPrefix: "PLT",
      name: "Platform",
      slug: "platform",
      status: "active",
    },
  ],
  query: "console",
  requests: [
    {
      displayKey: "RQP-14",
      id: "00000000-0000-4000-8000-000000000101",
      priority: "urgent",
      state: "in_progress",
      targetProjectName: "Platform",
      title: "Reskin the console",
    },
  ],
};

async function searchMarkup(q: string | string[] | undefined = "console") {
  const page = (await SearchPage({
    searchParams: Promise.resolve({ q }),
  })) as ReactElement;

  return renderToStaticMarkup(page);
}

beforeEach(() => {
  search.organization = {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  };
  search.run.mockReset();
  // The repository echoes the query it was asked, which is what the page reads
  // to decide whether it searched at all.
  search.run.mockImplementation(
    async (_userId: string, _organizationId: string, query: string) => ({
      ...results,
      query,
    }),
  );
});

describe("organization search", () => {
  test("keeps the query control named and submitting to the same route", async () => {
    const markup = await searchMarkup();

    expect(markup).toContain('action="/search"');
    expect(markup).toContain('name="q"');
    expect(markup).toContain('data-slot="field"');
    expect(markup).toContain("Search this organization");
    expect(markup).not.toContain(recipeClass("input"));
    expect(markup).not.toContain(recipeClass("button"));
  });

  test("puts both result sets in named, focusable native scroll regions", async () => {
    const markup = await searchMarkup();

    expect(markup.match(/data-slot="table-scroll-region"/gu)).toHaveLength(2);
    expect(markup).toContain('aria-label="Matching requests"');
    expect(markup).toContain('aria-label="Matching projects"');
    expect(markup.match(/tabindex="0"/gu)).toHaveLength(2);
    expect(markup.match(/data-slot="table-caption"/gu)).toHaveLength(2);
    expect(markup).toContain("Reskin the console");
    expect(markup).toContain("Platform");
  });

  test("reports no matches through the native empty state", async () => {
    search.run.mockResolvedValue({ ...results, projects: [], requests: [] });

    const markup = await searchMarkup();

    expect(markup).toContain('data-slot="empty-state"');
    expect(markup).toContain("No matching records");
  });

  test("asks for more characters before it searches at all", async () => {
    const markup = await searchMarkup("c");

    expect(markup).toContain("Enter at least two characters.");
    expect(markup).not.toContain('data-slot="table-scroll-region"');
  });

  test("searches nothing at all without an active organization", async () => {
    search.organization = null;

    const markup = await searchMarkup();

    expect(search.run).not.toHaveBeenCalled();
    expect(markup).toContain('data-slot="empty-state"');
    expect(markup).toContain("No matching records");
  });
});
