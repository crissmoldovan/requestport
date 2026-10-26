import { readFileSync } from "node:fs";

import { KeyRound } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import {
  isNavigationItemCurrent,
  NavigationLinks,
  navigationDestinations,
  navigationSections,
  settingsDestinations,
} from "./primary-navigation.js";

/** Every `href="…"` the markup carries, in document order. */
function hrefs(markup: string) {
  return [...markup.matchAll(/href="([^"]*)"/gu)].map((match) =>
    (match[1] ?? "").replaceAll("&amp;", "&"),
  );
}

/** The one link marked current, or `null` when none is. */
function currentHref(markup: string) {
  const current = markup.match(/<a[^>]*aria-current="page"[^>]*>/gu) ?? [];
  if (current.length > 1) throw new Error(`${current.length} current links`);
  const tag = current[0];
  return tag === undefined ? null : (hrefs(tag)[0] ?? null);
}

describe("PrimaryNavigation", () => {
  test("matches root exactly and settings links by route subtree", () => {
    expect(isNavigationItemCurrent("/", "/")).toBe(true);
    expect(isNavigationItemCurrent("/settings/projects", "/")).toBe(false);
    expect(
      isNavigationItemCurrent("/settings/projects/new", "/settings/projects"),
    ).toBe(true);
    expect(
      isNavigationItemCurrent("/settings/organization", "/settings/projects"),
    ).toBe(false);
  });

  test("keeps the query-scoped request views distinct from the list itself", () => {
    expect(isNavigationItemCurrent("/requests", "/requests?view=inbox")).toBe(
      false,
    );
    expect(
      isNavigationItemCurrent(
        "/requests",
        "/requests?view=inbox",
        "view=inbox",
      ),
    ).toBe(true);
    expect(
      isNavigationItemCurrent("/requests", "/requests", "view=inbox"),
    ).toBe(false);
  });

  test("groups the map into Work, Connect and Organization, in the reference build's order", () => {
    // Ruling 256, from docs/design/console-prototype/src/Console.tsx: three
    // sections, and the settings pages are one Settings entry rather than
    // seven rows of the map.
    expect(
      navigationSections.map((section) => ({
        destinations: section.destinations.map((item) => [
          item.href,
          item.label,
        ]),
        label: section.label,
      })),
    ).toEqual([
      {
        destinations: [
          ["/", "Overview"],
          ["/requests?view=inbox", "Inbox"],
          ["/requests?view=my_work", "My work"],
          ["/requests", "Requests"],
          ["/questions", "Questions"],
        ],
        label: "Work",
      },
      {
        destinations: [
          ["/agents", "Agents"],
          ["/webhooks", "Webhooks"],
          ["/slack", "Slack"],
          ["/imports", "Imports"],
        ],
        label: "Connect",
      },
      {
        destinations: [
          ["/activity", "Activity"],
          ["/settings/organization", "Settings"],
        ],
        label: "Organization",
      },
    ]);
    expect(navigationDestinations).toEqual(
      navigationSections.flatMap((section) => section.destinations),
    );
  });

  test("marks Settings current on every settings page, and nothing past the segment boundary", () => {
    for (const pathname of [
      "/settings/organization",
      "/settings/members",
      "/settings/projects",
      "/settings/projects/new",
      "/settings/routing",
      "/settings/operators",
      "/settings/operations",
      "/settings/appearance",
    ]) {
      expect({
        current: currentHref(
          renderToStaticMarkup(<NavigationLinks pathname={pathname} />),
        ),
        pathname,
      }).toEqual({ current: "/settings/organization", pathname });
    }

    // A path that only starts with the word marks nothing.
    expect(
      currentHref(
        renderToStaticMarkup(<NavigationLinks pathname="/settingsx" />),
      ),
    ).toBeNull();
    expect(
      currentHref(
        renderToStaticMarkup(<NavigationLinks pathname="/activity" />),
      ),
    ).toBe("/activity");
  });

  test("marks exactly one implemented link current in each navigation", () => {
    const markup = renderToStaticMarkup(
      <NavigationLinks pathname="/settings/projects/new" />,
    );

    expect(markup.match(/aria-current="page"/gu)).toHaveLength(1);
    expect(currentHref(markup)).toBe("/settings/organization");
    expect(markup).not.toContain('aria-disabled="true"');
  });

  test("lists the seven settings pages in the section navigation's order, Appearance last", () => {
    expect(settingsDestinations.map((item) => [item.href, item.label])).toEqual(
      [
        ["/settings/organization", "Organization"],
        ["/settings/members", "Members"],
        ["/settings/projects", "Projects"],
        ["/settings/routing", "Routing"],
        ["/settings/operators", "Operator keys"],
        ["/settings/operations", "Operations"],
        ["/settings/appearance", "Appearance"],
      ],
    );
    // Plan 13, F.3.1: one entry, drawn for every signed-in person whatever
    // the operator switch says; with the switch off it leads to the page's
    // unavailable state.
    expect(
      settingsDestinations.find((item) => item.href === "/settings/operators"),
    ).toEqual({
      href: "/settings/operators",
      icon: KeyRound,
      label: "Operator keys",
    });
    // None of them is a row of the primary map any longer.
    expect(
      navigationDestinations
        .map((item) => item.href)
        .filter((href) => href.startsWith("/settings/")),
    ).toEqual(["/settings/organization"]);
  });

  test("renders every destination as one native sidebar item, under three captions", () => {
    const markup = renderToStaticMarkup(<NavigationLinks pathname="/" />);

    expect(navigationDestinations).toHaveLength(11);
    expect(markup.match(/data-slot="sidebar-item"/gu)).toHaveLength(11);
    expect(markup.match(/data-slot="sidebar-item-label"/gu)).toHaveLength(11);
    expect(markup.match(/data-slot="sidebar-section"/gu)).toHaveLength(3);
    expect(
      [
        ...markup.matchAll(/data-slot="sidebar-section-label"[^>]*>([^<]*)</gu),
      ].map((match) => match[1]),
    ).toEqual(["Work", "Connect", "Organization"]);
    expect(hrefs(markup)).toEqual(
      navigationDestinations.map((item) => item.href),
    );
  });

  test("draws one decorative Lucide icon per destination and no local icon system", () => {
    const markup = renderToStaticMarkup(<NavigationLinks pathname="/" />);

    expect(markup.match(/<svg/gu)).toHaveLength(11);
    expect(markup.match(/class="lucide/gu)).toHaveLength(11);
    expect(markup.match(/aria-hidden="true"/gu)).toHaveLength(11);
    // Each destination its own glyph: My work and Activity used to share one.
    expect(new Set(navigationDestinations.map((item) => item.icon)).size).toBe(
      11,
    );
    expect(markup).not.toContain("navigation-icon");
    expect(markup).not.toMatch(/[⌁▦◇◉]/u);
    expect(markup).not.toContain(">·<");
  });

  test("keeps the density lane's two lists equal to this register", () => {
    // tests/e2e/density.spec.ts runs only in the driver's browser lanes, so a
    // register change it was not told about would surface there and nowhere
    // else. Reading its lists here moves that disagreement into this lane.
    const spec = readFileSync(
      new URL("../../tests/e2e/density.spec.ts", import.meta.url),
      "utf8",
    );
    const list = (name: string) => {
      const body = new RegExp(
        `const ${name} = \\[([\\s\\S]*?)\\] as const;`,
        "u",
      ).exec(spec)?.[1];
      return body === undefined
        ? null
        : [...body.matchAll(/"([^"]*)"/gu)].map((match) => match[1]);
    };

    expect({
      navigationHrefs: list("navigationHrefs"),
      settingsHrefs: list("settingsHrefs"),
    }).toEqual({
      navigationHrefs: navigationDestinations.map((item) => item.href),
      settingsHrefs: settingsDestinations.map((item) => item.href),
    });
  });
});
