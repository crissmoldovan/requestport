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

  test("renders every destination as one native sidebar item", () => {
    const markup = renderToStaticMarkup(<NavigationLinks pathname="/" />);

    expect(navigationDestinations).toHaveLength(15);
    expect(markup.match(/data-slot="sidebar-item"/gu)).toHaveLength(15);
    expect(markup.match(/data-slot="sidebar-item-label"/gu)).toHaveLength(15);
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

    expect(markup.match(/<svg/gu)).toHaveLength(15);
    expect(markup.match(/class="lucide/gu)).toHaveLength(15);
    expect(markup.match(/aria-hidden="true"/gu)).toHaveLength(15);
    expect(markup).not.toContain("navigation-icon");
    expect(markup).not.toMatch(/[⌁▦◇◉]/u);
    expect(markup).not.toContain(">·<");
  });
});
