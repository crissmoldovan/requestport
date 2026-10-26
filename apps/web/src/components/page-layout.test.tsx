import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { Page, PageSection, pageShellWidth } from "./page-layout.js";

/**
 * The installed `PageShell` supplies the measure *and* the page gutter, so the
 * number of shells a page opens is the number of page gutters it draws. These
 * tests count them.
 */

describe("page layout boundaries", () => {
  test("maps every RequestPort measure onto a published CUE++ page width", () => {
    expect(pageShellWidth).toEqual({
      administration: "wide",
      form: "narrow",
      wide: "broad",
    });
  });

  test("renders the page heading through the native page shell", () => {
    const markup = renderToStaticMarkup(
      <Page
        description="Canonical targets"
        eyebrow="Settings"
        title="Projects"
      />,
    );

    expect(markup).toContain('data-slot="page-shell"');
    expect(markup).toContain('data-slot="page-shell-header"');
    expect(markup).toContain('data-slot="page-shell-title"');
    expect(markup).toContain("<h1");
    expect(markup).toContain("Projects");
    expect(markup).toContain("Settings");
    expect(markup).toContain("Canonical targets");
    // `tests/fixtures/shell.ts` reads the current organization's slug as
    // `[data-slot="page-shell-header"] [data-slot="eyebrow"]`, so the nesting
    // is part of the contract rather than an implementation detail.
    expect(markup).toMatch(
      /data-slot="page-shell-header"[\s\S]*data-slot="eyebrow"[\s\S]*Settings/u,
    );
    expect(markup).not.toContain("page-header");
    expect(markup).not.toContain("page-eyebrow");
  });

  test("draws one padded measure column for a whole page", () => {
    const markup = renderToStaticMarkup(
      <Page
        description="Canonical targets"
        eyebrow="Settings"
        title="Projects"
        width="wide"
      >
        <PageSection labelledBy="projects">
          <h2 id="projects">Registered projects</h2>
        </PageSection>
        <PageSection labelledBy="lanes">
          <h2 id="lanes">Lanes</h2>
        </PageSection>
      </Page>,
    );

    // One shell is one gutter. Two shells put `py-(--cue-space-7)` on both
    // sides of the gap between the heading and the first panel, which is the
    // two full page paddings every migrated route used to draw.
    expect(markup.match(/data-slot="page-shell"/gu)).toHaveLength(1);
    expect(markup.match(/py-\(--cue-space-7\)/gu)).toHaveLength(1);
    expect(markup.match(/px-\(--cue-space-6\)/gu)).toHaveLength(1);
    // One measure too. Which length `broad` resolves to is the package's
    // business — writing the number here would both pin its choice and put a
    // raw arbitrary length in a file the native audit reads.
    expect(markup.match(/max-w-/gu)).toHaveLength(1);
  });

  test("keeps a labelled section bounded without a shell or a width of its own", () => {
    const markup = renderToStaticMarkup(
      <>
        <PageSection labelledBy="projects">
          <h2 id="projects">Registered projects</h2>
        </PageSection>
        <PageSection>Future workbench</PageSection>
      </>,
    );

    expect(markup).toContain('aria-labelledby="projects"');
    expect(markup.match(/<section/gu)).toHaveLength(2);
    // The measure and the gutter belong to the one column the sections sit in.
    expect(markup).not.toContain('data-slot="page-shell"');
    expect(markup).not.toContain("max-w-");
    expect(markup).not.toContain("content-section");
    expect(markup).not.toContain("page-width");
  });

  test("lets the eyebrow break a long unbroken token anywhere", () => {
    const markup = renderToStaticMarkup(
      <Page
        description="1 active member"
        eyebrow={`density-workspace-${"x".repeat(45)}`}
        title="Overview"
      />,
    );

    // `Eyebrow` is inline-flex, so its text is a flex item sized no smaller
    // than its min-content width. `break-word` leaves that width at the whole
    // token; `anywhere` is the value that lowers it.
    expect(markup).toMatch(
      /data-slot="eyebrow"[^>]*class="[^"]*\bwrap-anywhere\b/u,
    );
  });

  test("passes an action through the shell's own action slot", () => {
    const markup = renderToStaticMarkup(
      <Page
        action={<span>Create</span>}
        description="Canonical targets"
        eyebrow="Settings"
        title="Projects"
      />,
    );

    expect(markup).toContain('data-slot="page-shell-actions"');
    expect(markup).toContain("Create");
  });
});
