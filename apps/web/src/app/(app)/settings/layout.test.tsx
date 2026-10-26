import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

import SettingsLayout from "./layout.js";

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/members",
  useSearchParams: () => new URLSearchParams(),
}));

function layoutMarkup() {
  return renderToStaticMarkup(
    <SettingsLayout>
      <h1>Members</h1>
      <p>The page&rsquo;s own content.</p>
    </SettingsLayout>,
  );
}

describe("the settings layout", () => {
  test("draws the section navigation ahead of the page it wraps, and the page as it was handed over", () => {
    const markup = layoutMarkup();
    const navigation = markup.indexOf('aria-label="Settings"');

    expect(navigation).toBeGreaterThan(-1);
    expect(navigation).toBeLessThan(markup.indexOf("<h1>Members</h1>"));
    expect(markup).toContain("<h1>Members</h1><p>The page’s own content.</p>");
    expect(markup).toMatch(
      /<a[^>]*aria-current="page"[^>]*href="\/settings\/members"|<a[^>]*href="\/settings\/members"[^>]*aria-current="page"/u,
    );
    expect(markup.match(/aria-current="page"/gu)).toHaveLength(1);
  });

  test("opens no page column of its own", () => {
    // A page opens exactly one `PageShell` (page-layout.tsx), and the layout
    // above it must not add a second measure and gutter.
    expect(layoutMarkup()).not.toContain('data-slot="page-shell"');
  });

  test("wraps its two parts, so the navigation stacks above the page where they do not fit side by side", () => {
    const markup = layoutMarkup();
    const wrapper = /^<div[^>]*class="([^"]*)"/u.exec(markup)?.[1] ?? "";

    expect(wrapper.split(" ")).toEqual(
      expect.arrayContaining(["flex", "flex-row", "flex-wrap"]),
    );
    // The page's column takes the free space and gives it back only when the
    // line cannot hold both; the navigation takes a whole line once alone.
    expect(markup).toMatch(/<nav[^>]*class="[^"]*\bgrow\b/u);
    const column =
      /<div class="([^"]*)"><h1>Members<\/h1>/u.exec(markup)?.[1] ?? "";
    expect(column.split(" ")).toEqual(
      expect.arrayContaining(["min-w-0", "grow-999", "basis-lg"]),
    );
  });
});

/** Every `page.tsx` under the settings segment, as a directory below it. */
function settingsPages(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "page.tsx") found.push(directory);
    }
  };
  walk(root);
  return found.sort();
}

/**
 * The boundary file Next.js renders for a page that throws, or answers
 * not-found: the nearest `error.tsx` or `not-found.tsx` at or above the page's
 * directory, up to the application root.
 */
function nearestBoundary(
  directory: string,
  kind: "error" | "not-found",
  appRoot: string,
): string | undefined {
  let current = directory;
  while (current.startsWith(appRoot)) {
    if (existsSync(join(current, `${kind}.tsx`))) {
      return relative(appRoot, join(current, `${kind}.tsx`))
        .split(sep)
        .join("/");
    }
    if (current === appRoot) return undefined;
    current = dirname(current);
  }
  return undefined;
}

describe("the settings boundaries (ruling 260)", () => {
  const settingsRoot = import.meta.dirname;
  const appRoot = join(settingsRoot, "..", "..");

  test("catch a settings page that fails or is not found inside this layout, so the section navigation stays drawn", () => {
    // Next.js renders a segment's `error.tsx` and `not-found.tsx` inside that
    // segment's `layout.tsx`. A boundary above this directory, `(app)`'s,
    // renders above this layout, and the section navigation goes with the
    // page. So every settings page's nearest boundary must sit here or below.
    const boundaries = settingsPages(settingsRoot).map((directory) => ({
      error: nearestBoundary(directory, "error", appRoot),
      notFound: nearestBoundary(directory, "not-found", appRoot),
      page: relative(settingsRoot, directory).split(sep).join("/"),
    }));

    expect(boundaries).toEqual(
      boundaries.map(({ page }) => ({
        // The appearance page keeps the nearer error boundary it already had.
        error:
          page === "appearance"
            ? "(app)/settings/appearance/error.tsx"
            : "(app)/settings/error.tsx",
        notFound: "(app)/settings/not-found.tsx",
        page,
      })),
    );
  });
});
