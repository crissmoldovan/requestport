import {
  createElement,
  forwardRef,
  lazy,
  memo,
  type ReactElement,
} from "react";
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
import { ConsoleToasts } from "./console-toasts.js";

/**
 * A view rendered inside the console's one toast provider, which the shell
 * mounts around every page (ruling 260): a settings view's dialogs and member
 * controls raise their confirmations there, and need it above them. The
 * provider's viewport is a portal, so the markup is the view's alone.
 */
function renderInConsole(view: ReactElement) {
  return renderToStaticMarkup(<ConsoleToasts>{view}</ConsoleToasts>);
}

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
  joinedAt: new Date("2026-03-04T10:00:00.000Z"),
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

/** One rendering of the overview: a setup step open, a row and an event. */
const overview = {
  activity: [
    {
      actor: { type: "agent" },
      id: "event_1",
      occurredAt: new Date("2026-08-23T11:00:00.000Z"),
      type: "request.submitted",
    },
  ],
  attention: {
    failedDeliveries: [],
    questions: [],
    triage: [
      {
        displayKey: "RQP-1",
        id: "request_1",
        targetProjectName: "RequestPort",
        title: "Triage me",
        updatedAt: new Date("2026-08-23T11:30:00.000Z"),
      },
    ],
  },
  figures: {
    activeAgents: 1,
    connectedAgents: 1,
    failedDeliveries: 0,
    oldestQuestionAt: null,
    openRequests: 1,
    questionsForYou: 0,
    setup: { agent: true, project: true, routing: false, team: false },
  },
  health: {
    checkedAt: new Date("2026-08-23T12:00:00.000Z"),
    deadLetters: 0,
    lastDispatchAt: new Date("2026-08-23T11:58:00.000Z"),
    oldestUnprocessedAt: null,
    unprocessedEvents: 0,
  },
  now: new Date("2026-08-23T12:00:00.000Z"),
  organization,
  setupCard: {
    hidden: false,
    hide: async () => {},
    show: async () => {},
  },
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
  OverviewView: overview,
  ProjectCreationView: {
    action: async () => ({ message: "", status: "success" }),
    organization,
  },
  ProjectsView: { organization, projects: [project] },
};

describe("administration views", () => {
  test("renders the first-organization setup as a real accessible form", () => {
    const markup = renderInConsole(<NoOrganizationSetup />);

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
      const markup = renderInConsole(
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
      renderInConsole(<OverviewView {...overview} />),
      renderInConsole(<OrganizationView organization={organization} />),
      renderInConsole(
        <ProjectsView organization={organization} projects={[project]} />,
      ),
      renderInConsole(
        <ProjectCreationView
          action={async () => ({ message: "", status: "success" })}
          organization={organization}
        />,
      ),
      renderInConsole(
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
      renderInConsole(<OverviewView {...overview} />),
      renderInConsole(<OrganizationView organization={organization} />),
      renderInConsole(
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
      renderInConsole(
        <ProjectsView organization={organization} projects={[project]} />,
      ),
      renderInConsole(
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
  });

  test("offers project creation to an administrator from the header, in a dialog, and explains its absence to a member", () => {
    const createAction = async () => ({
      message: "",
      status: "success" as const,
    });
    const owner = renderInConsole(
      <ProjectsView
        createAction={createAction}
        organization={organization}
        projects={[]}
      />,
    );
    const ordinary = renderInConsole(
      <ProjectsView
        createAction={createAction}
        organization={{ ...organization, role: "member" }}
        projects={[]}
      />,
    );

    expect(owner).toContain('data-slot="dialog-trigger"');
    expect(owner).toContain("New project");
    expect(owner).not.toContain('href="/settings/projects/new"');
    expect(owner).not.toContain('name="keyPrefix"');
    expect(owner).toContain('data-slot="empty-state"');
    expect(ordinary).not.toContain("New project");
    expect(ordinary).not.toContain('data-slot="dialog-trigger"');
    expect(ordinary).toContain(
      "An organization owner or admin can register the first project.",
    );
  });

  test("lists pending invitations as rows, each with its own revoke", () => {
    const markup = renderInConsole(
      <MembersView
        currentUserId="user_1"
        invitationIdempotencyKeys={{ invite_1: "web:fixture:invite-key-0001" }}
        invitations={[invitation]}
        members={[member]}
        organization={organization}
        revokeInvitationAction={async () => ({ message: "", status: "idle" })}
      />,
    );

    expect(markup).not.toContain(
      'aria-label="Pending organization invitations"',
    );
    const pending = markup.slice(markup.indexOf('id="pending-invitations"'));
    expect(pending).toContain('data-slot="row"');
    expect(pending).toContain("pending@example.com");
    expect(pending).toContain("Revoke invitation");
  });

  test.each([
    ["an owner", "owner", ["pending@example.com", "owner-invite@example.com"]],
    ["an admin", "admin", ["pending@example.com"]],
  ] as const)(
    "offers %s Resend invitation beside Revoke invitation on exactly the invitations they may revoke (ruling 260)",
    (_label, role, manageable) => {
      const ownerInvitation = {
        email: "owner-invite@example.com",
        expiresAt: new Date("2026-08-24T12:00:00.000Z"),
        id: "invite_2",
        role: "owner" as const,
        version: 1,
      };
      const markup = renderInConsole(
        <MembersView
          currentUserId="user_9"
          invitationIdempotencyKeys={{
            invite_1: "web:fixture:invite-key-0001",
            invite_2: "web:fixture:invite-key-0002",
          }}
          invitationResendIdempotencyKeys={{
            invite_1: "web:fixture:resend-key-0001",
            invite_2: "web:fixture:resend-key-0002",
          }}
          invitations={[invitation, ownerInvitation]}
          members={[member]}
          organization={{ ...organization, role }}
          resendInvitationAction={async () => ({ message: "", status: "idle" })}
          revokeInvitationAction={async () => ({ message: "", status: "idle" })}
        />,
      );
      const pending = markup.slice(markup.indexOf('id="pending-invitations"'));
      const rows = pending
        .split('data-slot="row"')
        .slice(1)
        .map((row) => ({
          email: /owner-invite@example\.com|pending@example\.com/u.exec(
            row,
          )?.[0],
          resend: row.includes("Resend invitation"),
          revoke: row.includes("Revoke invitation"),
          // Each form posts its own key: the resend's is not the revocation's.
          resendKey: row.includes("web:fixture:resend-key-000"),
        }));

      expect(rows).toEqual(
        ["pending@example.com", "owner-invite@example.com"].map((email) => {
          const offered = (manageable as readonly string[]).includes(email);
          return {
            email,
            resend: offered,
            revoke: offered,
            resendKey: offered,
          };
        }),
      );
    },
  );

  test("puts inviting in the header and changes a role by choosing it, with a menu on every row the actor may revoke", () => {
    const memberAction = async () => ({ message: "", status: "idle" as const });
    const people = [
      member,
      {
        email: "admin@example.com",
        joinedAt: new Date("2026-06-07T23:30:00.000Z"),
        name: "Grace Hopper",
        role: "admin" as const,
        userId: "user_2",
        version: 2,
      },
    ];
    const markup = renderInConsole(
      <MembersView
        currentUserId="user_1"
        invitationAction={async () => ({ message: "", status: "success" })}
        invitations={[]}
        memberAction={memberAction}
        memberIdempotencyKeys={{
          user_1: "web:fixture:member-key-0001",
          user_2: "web:fixture:member-key-0002",
        }}
        members={people}
        organization={organization}
      />,
    );

    // The header's one primary action opens the invitation; the form is not
    // on the page until it does.
    expect(markup).toContain('data-slot="dialog-trigger"');
    expect(markup).toContain("Invite member");
    expect(markup).not.toContain('name="email"');
    // No separate save: the role control is the write.
    expect(markup).not.toContain("Save role");
    expect(markup).toContain('aria-label="Role for Owner"');
    expect(markup).toContain('aria-label="Role for Grace Hopper"');
    // A menu on the other person's row, none on the actor's own.
    expect(markup).toContain('aria-label="More for Grace Hopper"');
    expect(markup).not.toContain('aria-label="More for Owner"');
    // Each person by an avatar's initial, name and address.
    expect(markup).toContain(">G<");
    expect(markup).toContain("admin@example.com");
  });

  test.each([
    ["an owner", "owner"],
    ["an admin", "admin"],
    ["a member", "member"],
  ] as const)(
    "shows %s when each person joined, in a Joined column after Role (ruling 260)",
    (_label, role) => {
      const people = [
        member,
        {
          email: "admin@example.com",
          joinedAt: new Date("2026-06-07T23:30:00.000Z"),
          name: "Grace Hopper",
          role: "admin" as const,
          userId: "user_2",
          version: 2,
        },
      ];
      const markup = renderInConsole(
        <MembersView
          currentUserId="user_1"
          invitations={[]}
          memberAction={async () => ({ message: "", status: "idle" as const })}
          memberIdempotencyKeys={{
            user_1: "web:fixture:member-key-0001",
            user_2: "web:fixture:member-key-0002",
          }}
          members={people}
          organization={{ ...organization, role }}
        />,
      );
      const heads = [...markup.matchAll(/<th\b[^>]*>(.*?)<\/th>/gsu)].map(
        ([, cell]) => (cell ?? "").replace(/<[^>]+>/gu, ""),
      );

      expect(heads.slice(0, 3)).toEqual(["Person", "Role", "Joined"]);
      // The membership's own date, as the members page writes every date: the
      // UTC day, with the instant in `dateTime`.
      expect(markup).toMatch(
        /<time [^>]*dateTime="2026-03-04T10:00:00\.000Z"[^>]*>2026-03-04<\/time>/u,
      );
      expect(markup).toMatch(
        /<time [^>]*dateTime="2026-06-07T23:30:00\.000Z"[^>]*>2026-06-07<\/time>/u,
      );
    },
  );

  test("shows an admin an owner's role without a control or a menu", () => {
    const markup = renderInConsole(
      <MembersView
        currentUserId="user_2"
        invitations={[]}
        memberAction={async () => ({ message: "", status: "idle" as const })}
        memberIdempotencyKeys={{ user_1: "web:fixture:member-key-0001" }}
        members={[member]}
        organization={{ ...organization, role: "admin" }}
      />,
    );

    expect(markup).not.toContain('aria-label="Role for Owner"');
    expect(markup).not.toContain('aria-label="More for Owner"');
    expect(markup).toContain(">Owner<");
  });

  test("shows a member the people and their roles, and nothing to change", () => {
    // The page hands every role the member and invitation actions and their
    // keys, so the view's own role check is all that withholds them. Grace
    // Hopper's row is an admin's, which an owner or an admin would be offered
    // a role control for; the owner's row reads as a chip to anyone else.
    const markup = renderInConsole(
      <MembersView
        currentUserId="user_3"
        invitationAction={async () => ({ message: "", status: "success" })}
        invitations={[]}
        memberAction={async () => ({ message: "", status: "idle" as const })}
        memberIdempotencyKeys={{
          user_1: "web:fixture:member-key-0001",
          user_2: "web:fixture:member-key-0002",
        }}
        members={[
          member,
          {
            email: "admin@example.com",
            joinedAt: new Date("2026-06-07T23:30:00.000Z"),
            name: "Grace Hopper",
            role: "admin" as const,
            userId: "user_2",
            version: 2,
          },
        ]}
        organization={{ ...organization, role: "member" }}
      />,
    );

    expect(markup).toContain("owner@example.com");
    expect(markup).toContain("admin@example.com");
    expect(markup).not.toContain('data-slot="select-trigger"');
    expect(markup).not.toContain('aria-label="Role for');
    expect(markup).not.toContain("More for");
    expect(markup).not.toContain("Actions");
    expect(markup).not.toContain("Invite member");
    expect(markup).not.toContain('data-slot="dialog-trigger"');
  });

  test("refuses the project creation form to an ordinary member", () => {
    const markup = renderInConsole(
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
    const markup = renderInConsole(
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
    const markup = renderInConsole(
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
