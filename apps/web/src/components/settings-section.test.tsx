import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { SettingsSection } from "./settings-section.js";

/**
 * The administration section shell, read as markup.
 *
 * Every settings and agent surface repeats the same three parts — a bounded
 * page column, a panel, and a named heading the section is labelled by — so
 * the composition is asserted once here rather than at each of the thirty-odd
 * call sites that use it.
 */

describe("settings section", () => {
  test("names its own region with the heading it draws", () => {
    const markup = renderToStaticMarkup(
      <SettingsSection headingId="agents-heading" title="Registered agents">
        <p>Body</p>
      </SettingsSection>,
    );

    expect(markup).toContain('aria-labelledby="agents-heading"');
    expect(markup).toContain('id="agents-heading"');
    expect(markup).toContain("<h2");
    expect(markup).toContain("Registered agents");
  });

  test("composes a labelled region, panel, and panel header", () => {
    const markup = renderToStaticMarkup(
      <SettingsSection
        action={<span>Action</span>}
        headingId="rules-heading"
        note="4 configured"
        title="Rules"
      >
        <p>Body</p>
      </SettingsSection>,
    );

    // The measure and the page gutter belong to the one `Page` column the
    // section sits in: a shell here would be a second page gutter.
    expect(markup).not.toContain('data-slot="page-shell"');
    expect(markup).toContain("<section");
    expect(markup).toContain('data-slot="panel"');
    expect(markup).toContain('data-slot="panel-header"');
    expect(markup).toContain('data-slot="panel-header-actions"');
    expect(markup).toContain("4 configured");
    expect(markup).toContain("Action");
  });

  test("hands a full-bleed body the panel without the row gutter", () => {
    const gutter = renderToStaticMarkup(
      <SettingsSection headingId="a" title="Padded">
        <p>Body</p>
      </SettingsSection>,
    );
    const bleed = renderToStaticMarkup(
      <SettingsSection bleed headingId="b" title="Bled">
        <p>Body</p>
      </SettingsSection>,
    );

    expect(gutter).toContain('data-slot="row"');
    expect(bleed).not.toContain('data-slot="row"');
  });
});
