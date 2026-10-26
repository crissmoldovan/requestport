import { existsSync, readdirSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { settingsDestinations } from "../../../components/primary-navigation.js";
import { SettingsNavigationLinks } from "./settings-navigation.js";

/** Every `href="…"` the markup carries, in document order. */
function hrefs(markup: string) {
  return [...markup.matchAll(/href="([^"]*)"/gu)].map((match) => match[1]);
}

/** The one link marked current, or `null` when none is. */
function currentHref(markup: string) {
  const current = markup.match(/<a[^>]*aria-current="page"[^>]*>/gu) ?? [];
  if (current.length > 1) throw new Error(`${current.length} current links`);
  const tag = current[0];
  return tag === undefined ? null : (hrefs(tag)[0] ?? null);
}

describe("the settings section navigation", () => {
  test("is one navigation landmark named Settings, drawing the seven pages in order", () => {
    const markup = renderToStaticMarkup(
      <SettingsNavigationLinks pathname="/settings/organization" />,
    );

    expect(markup.match(/<nav/gu)).toHaveLength(1);
    expect(markup).toMatch(/^<nav[^>]*aria-label="Settings"/u);
    expect(markup.match(/data-slot="sidebar-item"/gu)).toHaveLength(7);
    expect(hrefs(markup)).toEqual(
      settingsDestinations.map((item) => item.href),
    );
    expect(
      [
        ...markup.matchAll(/data-slot="sidebar-item-label"[^>]*>([^<]*)</gu),
      ].map((match) => match[1]),
    ).toEqual([
      "Organization",
      "Members",
      "Projects",
      "Routing",
      "Operator keys",
      "Operations",
      "Appearance",
    ]);
  });

  test("marks each page current on its own route and below it, and nothing past the segment boundary", () => {
    const cases: Array<[string, string | null]> = [
      ["/settings/organization", "/settings/organization"],
      ["/settings/members", "/settings/members"],
      ["/settings/projects", "/settings/projects"],
      ["/settings/projects/new", "/settings/projects"],
      [
        "/settings/projects/00000000-0000-4000-8000-000000000001",
        "/settings/projects",
      ],
      ["/settings/routing", "/settings/routing"],
      // The two paths share "/settings/operat", so each must mark only itself.
      ["/settings/operators", "/settings/operators"],
      ["/settings/operations", "/settings/operations"],
      ["/settings/appearance", "/settings/appearance"],
      ["/settings/operatorsx", null],
      ["/requests", null],
    ];

    for (const [pathname, expected] of cases) {
      expect({
        current: currentHref(
          renderToStaticMarkup(<SettingsNavigationLinks pathname={pathname} />),
        ),
        pathname,
      }).toEqual({ current: expected, pathname });
    }
  });

  test("draws one decorative Lucide icon per page and no collapse rail", () => {
    const markup = renderToStaticMarkup(
      <SettingsNavigationLinks pathname="/settings/members" />,
    );

    expect(markup.match(/<svg/gu)).toHaveLength(7);
    expect(markup.match(/class="lucide/gu)).toHaveLength(7);
    expect(markup.match(/aria-hidden="true"/gu)).toHaveLength(7);
    expect(markup).not.toContain('data-slot="sidebar-rail"');
    expect(markup).not.toContain("<button");
  });

  test("leaves off the primary column's ground and rim, and grows across a line it has alone", () => {
    const classes = (
      /^<nav[^>]*class="([^"]*)"/u.exec(
        renderToStaticMarkup(
          <SettingsNavigationLinks pathname="/settings/members" />,
        ),
      )?.[1] ?? ""
    ).split(" ");

    // `cn` resolves the override, so the column's own utilities are gone
    // rather than left to fight it by stylesheet order.
    expect(classes).toEqual(
      expect.arrayContaining(["grow", "border-r-0", "bg-transparent"]),
    );
    expect(classes).not.toContain("bg-surface-1");
    expect(classes).not.toContain("border-r");
  });

  test("links every settings page directory, and no address that has none", () => {
    // A settings page added without a row here would render under the layout
    // with no way to reach it from the section navigation.
    const root = new URL("./", import.meta.url);
    const pageDirectories = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => existsSync(new URL(`${entry.name}/page.tsx`, root)))
      .map((entry) => `/settings/${entry.name}`)
      .sort();

    expect([...settingsDestinations.map((item) => item.href)].sort()).toEqual(
      pageDirectories,
    );
  });
});
