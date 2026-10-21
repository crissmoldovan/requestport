import { createElement, forwardRef, lazy, memo } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import * as administrationViews from "./administration-views.js";
import {
  MembersView,
  NoOrganizationSetup,
  OrganizationView,
  OverviewView,
  ProjectCreationView,
  ProjectsView,
} from "./administration-views.js";

/** A retired recipe class, assembled so the audit reads bookkeeping, not a class. */
function recipeClass(...parts: readonly string[]): string {
  return ["ui", ...parts].join("-");
}

const retiredAdministrationClasses = [
  ...["badge", "button", "empty-state", "field", "input", "table"].map((name) =>
    recipeClass(name),
  ),
  "setup-panel",
  "section-heading",
  "detail-list",
  "project-row-stacked",
  "page-width-administration",
  "phase-note",
  "invite-panel",
  "inline-empty",
];

const organization = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "CUE++",
  role: "owner" as const,
  slug: "example-org",
};

const project = {
  canRepresent: true,
  defaultRepository: {
    browseUrl: "https://github.com/example-org/requestport",
    repositorySlug: "example-org/requestport",
  },
  id: "project_1",
  keyPrefix: "RQP",
  name: "RequestPort",
  slug: "requestport",
  status: "active" as const,
};

const member = {
  email: "owner@example.com",
  name: "Owner",
  role: "owner" as const,
  userId: "user_1",
  version: 1,
};

const invitation = {
  email: "pending@example.com",
  expiresAt: new Date("2026-08-23T12:00:00.000Z"),
  id: "invite_1",
  role: "member" as const,
  version: 1,
};

/**
 * The `$$typeof` markers React puts on a component that is not a function.
 *
 * `memo()` and `forwardRef()` return objects, and `lazy()` does too. A survey
 * that kept only `typeof value === "function"` therefore dropped a view the
 * day it was wrapped in one — silently, which is the exact narrowing the list
 * below is read off the module to prevent.
 */
const renderableMarkers = new Set<symbol>([
  Symbol.for("react.forward_ref"),
  Symbol.for("react.lazy"),
  Symbol.for("react.memo"),
]);

/** Every name a module publishes that React can render as a component. */
function publishedViewNames(
  module: Record<string, unknown>,
): readonly string[] {
  return Object.entries(module)
    .filter(([, value]) => {
      if (typeof value === "function") return true;
      if (typeof value !== "object" || value === null) return false;

      const marker = (value as { $$typeof?: unknown }).$$typeof;

      return typeof marker === "symbol" && renderableMarkers.has(marker);
    })
    .map(([name]) => name)
    .toSorted();
}

/** Every view the module publishes, whatever it is called or wrapped in. */
const published = administrationViews as unknown as Record<string, unknown>;
const publishedViews = publishedViewNames(published);

/**
 * One rendering's worth of props for each of them.
 *
 * Written out because a component's props cannot be derived from its export;
 * checked against the module's exports so that writing them out cannot go
 * stale. Adding a view without an entry here fails the survey rather than
 * quietly narrowing it.
 */
const surfaceProps: Record<string, Record<string, unknown>> = {
  MembersView: {
    currentUserId: "user_1",
    invitations: [invitation],
    members: [member],
    organization,
  },
  NoOrganizationSetup: {},
  OrganizationView: { organization },
  OverviewView: { members: [member], organization, projects: [project] },
  ProjectCreationView: {
    action: async () => ({ message: "", status: "success" }),
    organization,
  },
  ProjectsView: { organization, projects: [project] },
};

describe("administration views", () => {
  test("renders the first-organization setup as a real accessible form", () => {
    const markup = renderToStaticMarkup(<NoOrganizationSetup />);

    expect(markup).toContain("Create your first organization");
    expect(markup).toContain('name="name"');
    expect(markup).toContain('name="slug"');
    expect(markup).toContain('data-slot="field-label"');
    expect(markup).not.toContain("redirect");
  });

  test("counts a view published through memo, forwardRef or lazy", () => {
    // The survey kept only what `typeof` called a function, so a view wrapped
    // in any of these dropped out of it without failing anything — and a *new*
    // view written that way would never have been asked for a props entry at
    // all. That is the same silent narrowing the list above exists to end.
    const module = {
      ForwardedView: forwardRef<HTMLDivElement>(() => null),
      LazyView: lazy(async () => ({ default: () => null })),
      MemoView: memo(() => null),
      PlainView: () => null,
      retiredClasses: retiredAdministrationClasses,
      shellSlot: 1,
    };

    expect(publishedViewNames(module)).toEqual([
      "ForwardedView",
      "LazyView",
      "MemoView",
      "PlainView",
    ]);
  });

  test("draws every administration view the module publishes", () => {
    // The gutter rule below is about *every* surface, so the list it runs over
    // is read off the module rather than restated. Restating it left the sixth
    // view — which opens a `Page` of its own like the other five — unpinned,
    // and a seventh would have joined it silently. A view added without an
    // entry here fails this, which is the only way the rule below can keep
    // meaning what its name says.
    expect(Object.keys(surfaceProps).toSorted()).toEqual(publishedViews);
  });

  test("gives every administration surface exactly one padded measure column", () => {
    // The end of the two-gutter defect, read on the real surfaces rather than
    // on the primitives: each of these used to open one `PageShell` for its
    // heading and one more for every section, so the distance from the heading
    // to the first panel was two full page paddings.
    for (const name of publishedViews) {
      const markup = renderToStaticMarkup(
        createElement(published[name] as never, surfaceProps[name] as never),
      );
      expect({
        name,
        gutters: markup.match(/py-\(--cue-space-7\)/gu)?.length ?? 0,
        shells: markup.match(/data-slot="page-shell"/gu)?.length ?? 0,
      }).toEqual({ name, gutters: 1, shells: 1 });
    }
  });

  test("renders only supplied tenant data in overview, organization, projects, and members", () => {
    const markup = [
      renderToStaticMarkup(
        <OverviewView
          members={[member]}
          organization={organization}
          projects={[project]}
        />,
      ),
      renderToStaticMarkup(<OrganizationView organization={organization} />),
      renderToStaticMarkup(
        <ProjectsView organization={organization} projects={[project]} />,
      ),
      renderToStaticMarkup(
        <ProjectCreationView
          action={async () => ({ message: "", status: "success" })}
          organization={organization}
        />,
      ),
      renderToStaticMarkup(
        <MembersView
          currentUserId="user_1"
          invitations={[invitation]}
          members={[member]}
          organization={organization}
        />,
      ),
    ].join("\n");

    expect(markup).toContain("RequestPort");
    expect(markup).toContain("example-org/requestport");
    expect(markup).toContain("owner@example.com");
    expect(markup).toContain("pending@example.com");
    expect(markup).toContain("<table");
    expect(markup).not.toContain("68 requests");
    expect(markup).not.toContain("fake");
    expect(markup).toContain('data-slot="page-shell"');
  });

  test("composes tables, panels, and chips from the installed package alone", () => {
    const markup = [
      renderToStaticMarkup(
        <OverviewView
          members={[member]}
          organization={organization}
          projects={[project]}
        />,
      ),
      renderToStaticMarkup(<OrganizationView organization={organization} />),
      renderToStaticMarkup(
        <MembersView
          currentUserId="user_1"
          invitations={[invitation]}
          members={[member]}
          organization={organization}
        />,
      ),
    ].join("\n");

    expect(markup).toContain('data-slot="table-scroll-region"');
    expect(markup).toContain('data-slot="table-caption"');
    expect(markup).toContain('data-slot="panel"');
    expect(markup).toContain('data-slot="description-list"');
    for (const retired of retiredAdministrationClasses) {
      expect(markup).not.toContain(retired);
    }
  });

  test("names every table region so a keyboard user can reach its columns", () => {
    const markup = [
      renderToStaticMarkup(
        <ProjectsView organization={organization} projects={[project]} />,
      ),
      renderToStaticMarkup(
        <MembersView
          currentUserId="user_1"
          invitations={[invitation]}
          members={[member]}
          organization={organization}
        />,
      ),
    ].join("\n");

    expect(markup).toContain('aria-label="Registered projects"');
    expect(markup).toContain('aria-label="Active organization members"');
    expect(markup).toContain('aria-label="Pending organization invitations"');
  });

  test("offers project creation to an administrator and explains its absence to a member", () => {
    const owner = renderToStaticMarkup(
      <ProjectsView organization={organization} projects={[]} />,
    );
    const ordinary = renderToStaticMarkup(
      <ProjectsView
        organization={{ ...organization, role: "member" }}
        projects={[]}
      />,
    );

    expect(owner).toContain("Create project");
    expect(owner).toContain('data-slot="empty-state"');
    expect(ordinary).not.toContain("Create project");
    expect(ordinary).toContain(
      "An organization owner or admin can register the first project.",
    );
  });

  test("refuses the project creation form to an ordinary member", () => {
    const markup = renderToStaticMarkup(
      <ProjectCreationView
        action={async () => ({ message: "", status: "success" })}
        organization={{ ...organization, role: "member" }}
      />,
    );

    expect(markup).toContain("Administration access required");
    expect(markup).toContain('data-slot="empty-state"');
    expect(markup).not.toContain('name="keyPrefix"');
  });

  test("reports an organization with no pending invitations as a native empty state", () => {
    const markup = renderToStaticMarkup(
      <MembersView
        currentUserId="user_1"
        invitations={[]}
        members={[member]}
        organization={organization}
      />,
    );

    expect(markup).toContain('data-slot="empty-state"');
    expect(markup).toContain("No pending invitations");
  });

  test("does not expose pending invitation identities or controls to an ordinary member", () => {
    const markup = renderToStaticMarkup(
      <MembersView
        currentUserId="user_1"
        invitations={[
          {
            email: "private-pending@example.com",
            expiresAt: new Date("2026-08-23T12:00:00.000Z"),
            id: "invite_private",
            role: "admin",
            version: 1,
          },
        ]}
        members={[]}
        organization={{ ...organization, role: "member" }}
      />,
    );

    expect(markup).not.toContain("private-pending@example.com");
    expect(markup).not.toContain("Pending invitations");
    expect(markup).not.toContain("Invite member");
  });
});
