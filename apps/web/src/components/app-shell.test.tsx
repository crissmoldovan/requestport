import type { AppearanceSnapshot } from "@requestport/domain/browser";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

import { AppShell } from "./app-shell.js";

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/members",
  useSearchParams: () => new URLSearchParams(),
}));

const snapshot: AppearanceSnapshot = {
  effective: {
    density: "ultra-compact",
    mode: "system",
    source: {
      density: "fallback",
      mode: "fallback",
      theme: "fallback",
    },
    theme: "requestport",
  },
  organization: {
    density: "ultra-compact",
    mode: "system",
    theme: "requestport",
    version: 0,
  },
  user: { density: null, mode: null, theme: null, version: 0 },
};

function shellMarkup() {
  return renderToStaticMarkup(
    <AppShell
      appearance={{
        canEditOrganizationDefaults: false,
        contextToken: "v1.render.context",
        idempotencyNonce: "6f1c2f1e-0000-4000-8000-000000000001",
        organizationName: "CUE++",
        snapshot,
      }}
      currentOrganization={{
        id: "00000000-0000-4000-8000-000000000001",
        name: "CUE++",
        role: "owner",
        slug: "example-org",
      }}
      organizations={[
        {
          id: "00000000-0000-4000-8000-000000000001",
          name: "CUE++",
          role: "owner",
          slug: "example-org",
        },
      ]}
      user={{ email: "owner@example.com", image: null, name: "Owner" }}
    >
      <h1>Overview</h1>
    </AppShell>,
  );
}

/**
 * The retired shell recipes. Every one of them named a piece of geometry the
 * native frame now owns, so their absence is what proves the migration
 * happened rather than merely compiled.
 */
const retiredShellClasses = [
  "app-content",
  "app-frame",
  "command-button",
  "desktop-rail",
  "mobile-navigation",
  "new-request-button",
  "rail-list",
  "top-bar",
  "wordmark",
];

describe("AppShell accessibility", () => {
  test("renders semantic landmarks and the implemented navigation", () => {
    const markup = shellMarkup();

    expect(markup).toContain("<header");
    expect(markup).toContain("<nav");
    expect(markup).toContain("<main");
    expect(markup).toContain('href="/settings/projects"');
    expect(markup).toContain('href="/settings/organization"');
    expect(markup).toContain('href="/settings/members"');
    expect(markup).not.toContain('aria-disabled="true"');
    expect(markup).toContain("Requests");
    expect(markup).toContain("New request");
    expect(markup).toContain('href="/questions"');
    expect(markup).toContain('href="/activity"');
    expect(markup).toContain("Overview");
    // The native frame publishes one navigation column; the drawer that carries
    // the same items on a narrow viewport only exists once it is opened, so a
    // closed document announces the map exactly once.
    expect(markup.match(/<nav/gu)).toHaveLength(1);
    expect(markup.match(/<main/gu)).toHaveLength(1);
    expect(markup.match(/aria-current="page"/gu)).toHaveLength(1);
    expect(markup).toMatch(
      /href="\/settings\/members"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/settings\/members"/u,
    );
  });

  test("reaches the search and new-request destinations through native controls", () => {
    const markup = shellMarkup();

    expect(markup).toContain('href="/search"');
    expect(markup).toContain('href="/requests/new"');
    expect(markup).toContain("<kbd");
    expect(markup).toContain('data-slot="app-bar-actions"');
  });

  test("offers the drawer trigger that opens the narrow-viewport navigation", () => {
    const markup = shellMarkup();

    expect(markup).toContain('data-slot="app-shell-nav-trigger"');
    expect(markup).toContain('aria-label="Open navigation"');
    expect(markup).toContain('aria-expanded="false"');
    // The retired disclosure pair is what the native drawer replaces.
    expect(markup).not.toContain("<details");
    expect(markup).not.toContain("<summary");
  });

  test("leaves no retired shell recipe or local icon system behind", () => {
    const markup = shellMarkup();

    for (const retired of retiredShellClasses) {
      expect({ markup: markup.includes(retired), retired }).toEqual({
        markup: false,
        retired,
      });
    }
    expect(markup).not.toContain("navigation-icon");
    expect(markup).not.toContain("<select");
  });

  test("names the account menu trigger and keeps its panel closed", () => {
    const markup = shellMarkup();

    expect(markup).toContain('aria-label="Open user menu for Owner"');
    // The account menu is a popover: its appearance panel, sign-out control,
    // and settings link only exist once a person opens it, so nothing about the
    // signed-in account is rendered into the closed document.
    expect(markup).not.toContain("Sign out");
    expect(markup).not.toContain("owner@example.com");
    expect(markup).not.toContain("v1.render.context");
  });
});
