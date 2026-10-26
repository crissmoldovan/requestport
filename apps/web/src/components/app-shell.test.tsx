import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import type { AppearanceSnapshot } from "@requestport/domain/browser";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

import { withoutComments } from "../test/source-text.js";
import { AppShell } from "./app-shell.js";

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/members",
  useSearchParams: () => new URLSearchParams(),
}));

const snapshot: AppearanceSnapshot = {
  effective: {
    density: "ultra-compact",
    font: "match",
    look: "match",
    mode: "system",
    paint: "match",
    source: {
      density: "fallback",
      font: "fallback",
      look: "fallback",
      mode: "fallback",
      paint: "fallback",
      theme: "fallback",
    },
    theme: "requestport",
  },
  organization: {
    density: "ultra-compact",
    font: "match",
    look: "match",
    mode: "system",
    paint: "match",
    theme: "requestport",
    version: 0,
  },
  user: {
    density: null,
    font: null,
    look: null,
    mode: null,
    paint: null,
    theme: null,
    version: 0,
  },
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
  test("renders semantic landmarks and the grouped navigation", () => {
    const markup = shellMarkup();

    // `AppShell.Bar` is a `<div>`, so the banner is its role rather than a
    // `<header>` element.
    expect(markup).toMatch(
      /<div[^>]*data-slot="app-shell-bar"[^>]*role="banner"|<div[^>]*role="banner"[^>]*data-slot="app-shell-bar"/u,
    );
    expect(markup).not.toContain("<header");
    expect(markup).toContain("<nav");
    expect(markup).toContain("<main");
    expect(markup).not.toContain('aria-disabled="true"');
    expect(markup).toContain('href="/questions"');
    expect(markup).toContain('href="/activity"');
    expect(markup).toContain("Overview");
    expect(markup).toContain("Requests");
    // The settings pages are one Settings entry in the shell; their own links
    // are the settings layout's section navigation, not the shell's.
    expect(markup).toContain('href="/settings/organization"');
    expect(markup).not.toContain('href="/settings/projects"');
    expect(markup).not.toContain('href="/settings/members"');
    // The native frame publishes one navigation column; the drawer that carries
    // the same items on a narrow viewport only exists once it is opened, so a
    // closed document announces the map exactly once.
    expect(markup.match(/<nav/gu)).toHaveLength(1);
    expect(markup.match(/<main/gu)).toHaveLength(1);
    // On /settings/members the one current row is Settings.
    expect(markup.match(/aria-current="page"/gu)).toHaveLength(1);
    expect(markup).toMatch(
      /href="\/settings\/organization"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/settings\/organization"/u,
    );
  });

  test("lays the bar out as brand, tenant and search, then the account menu", () => {
    const markup = shellMarkup();
    const at = (needle: string) => {
      const index = markup.indexOf(needle);
      expect({ found: index > -1, needle }).toEqual({ found: true, needle });
      return index;
    };

    // The brand cell over the navigation column: the drawer trigger, then the
    // mark and name linking to the overview.
    const brand = at('data-slot="app-shell-brand"');
    const trigger = at('data-slot="app-shell-nav-trigger"');
    const home = at('aria-label="RequestPort overview"');
    // The rest of the bar: the tenant switcher, then the search entry.
    const leading = at('data-slot="app-shell-bar-leading"');
    const switcher = at('aria-label="Current organization"');
    const search = at('href="/search"');
    // The trailing cluster: the account menu.
    const actions = at('data-slot="app-shell-bar-actions"');
    const account = at('aria-label="Open user menu for Owner"');

    const order = [
      brand,
      trigger,
      home,
      leading,
      switcher,
      search,
      actions,
      account,
    ];
    expect(order).toEqual([...order].sort((left, right) => left - right));
    // The bar's `center` slot is inert by construction (pointer-events-none),
    // so nothing is put in it.
    expect(markup).not.toContain('data-slot="app-shell-bar-center"');
    // The search entry is centred in the space after the switcher, and the
    // name beside the mark hides when the sidebar collapses to a rail.
    expect(markup).toMatch(
      /<a[^>]*class="[^"]*\bmx-auto\b[^"]*"[^>]*href="\/search"|<a[^>]*href="\/search"[^>]*class="[^"]*\bmx-auto\b/u,
    );
    expect(markup).toMatch(
      /<span class="group-data-\[rail\]\/app-shell:hidden">requestport<\/span>/u,
    );
  });

  test("reaches search through a native control and offers no New request in the bar", () => {
    const markup = shellMarkup();

    expect(markup).toContain('href="/search"');
    expect(markup).toContain("<kbd");
    // Ruling 256: New request stays in the Requests page's header.
    expect(markup).not.toContain('href="/requests/new"');
    expect(markup).not.toContain("New request");
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

/** Every non-test module under `apps/web/src`, relative to it. */
function applicationModules(): { file: string; source: string }[] {
  const root = resolve(import.meta.dirname, "..");
  const found: { file: string; source: string }[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.tsx?$/u.test(entry.name) || /\.test\.tsx?$/u.test(entry.name)) {
        continue;
      }
      found.push({
        file: relative(root, path).split(sep).join("/"),
        source: withoutComments(readFileSync(path, "utf8")),
      });
    }
  };
  walk(root);
  return found;
}

describe("the console's toasts (ruling 260)", () => {
  test("have one provider and one viewport, mounted by the shell and nowhere else", () => {
    // A provider per page ended with the page: a toast raised as a write
    // redirected or revalidated went with the subtree that held its provider.
    // One provider in the shell outlives every page below it.
    const mounts = applicationModules().flatMap(({ file, source }) => [
      ...[
        ...source.matchAll(
          /<(Toast\.Provider|Toast\.Viewport|ConsoleToasts)\b/gu,
        ),
      ].map(([, part]) => `${file}: ${part}`),
      ...(source.includes("SettingsToasts") ? [`${file}: SettingsToasts`] : []),
    ]);

    expect(mounts.sort()).toEqual([
      "components/app-shell.tsx: ConsoleToasts",
      "components/console-toasts.tsx: Toast.Provider",
      "components/console-toasts.tsx: Toast.Viewport",
    ]);
  });
});
