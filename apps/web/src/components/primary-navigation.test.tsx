import { KeyRound } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import {
  isNavigationItemCurrent,
  NavigationLinks,
  navigationDestinations,
} from "./primary-navigation.js";

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

  test("marks exactly one implemented link current in each navigation", () => {
    const markup = renderToStaticMarkup(
      <NavigationLinks pathname="/settings/projects/new" />,
    );

    expect(markup.match(/aria-current="page"/gu)).toHaveLength(1);
    expect(markup).toMatch(
      /<a[^>]*aria-current="page"[^>]*href="\/settings\/projects"|<a[^>]*href="\/settings\/projects"[^>]*aria-current="page"/u,
    );
    expect(markup).not.toContain('aria-disabled="true"');
  });

  test("draws the operator credentials page between Operations and Agents, current on its own route only", () => {
    const hrefs = navigationDestinations.map((item) => item.href);
    const operations = hrefs.indexOf("/settings/operations");

    // Plan 13, F.3.1: one entry, with the other settings pages, drawn for
    // every signed-in person whatever the operator switch says; with the
    // switch off it leads to the page's unavailable state.
    expect(hrefs.slice(operations, operations + 3)).toEqual([
      "/settings/operations",
      "/settings/operators",
      "/agents",
    ]);
    expect(navigationDestinations[operations + 1]).toEqual({
      href: "/settings/operators",
      icon: KeyRound,
      label: "Operator keys",
    });

    // The two paths share "/settings/operat", so each must mark only itself.
    for (const pathname of ["/settings/operators", "/settings/operations"]) {
      const markup = renderToStaticMarkup(
        <NavigationLinks pathname={pathname} />,
      );
      expect({
        current: markup.match(/aria-current="page"/gu)?.length ?? 0,
        pathname,
      }).toEqual({ current: 1, pathname });
      expect(markup).toMatch(
        new RegExp(
          `<a[^>]*aria-current="page"[^>]*href="${pathname}"|<a[^>]*href="${pathname}"[^>]*aria-current="page"`,
          "u",
        ),
      );
    }
    // A longer path that only starts with one of them marks neither.
    expect(
      renderToStaticMarkup(<NavigationLinks pathname="/settings/operatorsx" />),
    ).not.toContain('aria-current="page"');
  });

  test("renders every destination as one native sidebar item", () => {
    const markup = renderToStaticMarkup(<NavigationLinks pathname="/" />);

    expect(navigationDestinations).toHaveLength(16);
    expect(markup.match(/data-slot="sidebar-item"/gu)).toHaveLength(16);
    expect(markup.match(/data-slot="sidebar-item-label"/gu)).toHaveLength(16);
    expect(markup).toContain('data-slot="sidebar-section-label"');
    for (const destination of navigationDestinations) {
      expect({
        found: markup.includes(`href="${destination.href}"`),
        href: destination.href,
      }).toEqual({ found: true, href: destination.href });
    }
  });

  test("draws one decorative Lucide icon per destination and no local icon system", () => {
    const markup = renderToStaticMarkup(<NavigationLinks pathname="/" />);

    expect(markup.match(/<svg/gu)).toHaveLength(16);
    expect(markup.match(/class="lucide/gu)).toHaveLength(16);
    expect(markup.match(/aria-hidden="true"/gu)).toHaveLength(16);
    expect(markup).not.toContain("navigation-icon");
    expect(markup).not.toMatch(/[⌁▦◇◉]/u);
    expect(markup).not.toContain(">·<");
  });
});
